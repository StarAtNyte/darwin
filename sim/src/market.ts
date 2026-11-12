// In-process market with the same rules as the v2 contract (contract/src/lib.rs, darwin_market v2).
// The economy runs here at simulation speed; chain.ts runs the same calls on testnet. Conservation
// (pool + balances + escrow) is asserted every tick.
//
// What mirrors the contract:
//   - transfer() pays only with a guard-signed approval (same message, ed25519, nonce, expiry, per-agent caps) and
//     returns a refusal with a reason code instead of throwing;
//   - tasks carry sha256(task_id || canonical answer); submit() records an answer only if it hashes to it;
//     settle() pays a verified winner and refunds the pool otherwise; both are gated by the task's windows;
//   - chargeUpkeep() at most once per agent per epoch; kill() only below the floor;
//   - the market fee is taken inside settle(); burn() is an agent paying back to the pool.
// Sim-only: closeAuction(task, "price") (the wind tunnel's lowest-price counterfactual; the contract is always
// reputation-weighted). Amounts are numbers (micro-credits) here and u128 on chain; times are ms here, ns on chain.
import { answerHash, approvalMessage, verifyApproval, type SignedApproval } from "./v2.ts";

export interface AgentRec {
  id: string;
  balance: number;
  reputation: number; // 0..2000, start 1000
  alive: boolean;
  parent?: string;
  generation: number;
  wins: number;
  losses: number;
  bornTick: number;
  diedTick?: number;
  lastUpkeepEpoch?: number;
  window: number;
  windowSpent: number;
}

export interface TaskRec {
  id: number;
  kind: string;
  reward: number;
  answerHash: string;
  bidClose: number;
  deadline: number;
  status: "Open" | "Awarded" | "Verified" | "Settled" | "Expired";
  bids: { agent: string; price: number }[];
  winner?: string;
  price?: number;
  answer?: string;
  submits: number;
}

export interface MarketRules {
  upkeep: number;
  epochMs: number;
  floor: number;
  /** Fraction of the price (the contract's fee_bps / 10000). */
  fee: number;
  perTxCap: number;
  windowCap: number;
  windowMs: number;
  maxTtlMs: number;
}

export interface Outcome {
  ok: boolean;
  reason?: string;
}

export type MarketEvent =
  | { event: "register"; agent: string; parent?: string; seed: number }
  | { event: "fork"; parent: string; child: string; seed: number }
  | { event: "post"; task: number; kind: string; reward: number }
  | { event: "award"; task: number; winner: string; price: number }
  | { event: "expire"; task: number }
  | { event: "submit_refused"; task: number; agent: string; reason: string }
  | { event: "settle"; task: number; winner: string; correct: boolean; paid: number; fee: number }
  | { event: "transfer"; from: string; to: string; amount: number; memo: string }
  | { event: "transfer_refused"; from: string; to: string; amount: number; memo: string; reason: string }
  | { event: "burn"; agent: string; amount: number }
  | { event: "upkeep"; agent: string; amount: number }
  | { event: "kill"; agent: string; balance: number };

export class MarketError extends Error {}

export const MAX_SUBMITS = 3;
/** The sim's market id and network tag: what the guard signs over in the sim (testnet uses the real ones). */
export const SIM_MARKET = "market.darwin.testnet";
export const SIM_NETWORK = "sim";

export const DEFAULT_RULES: MarketRules = {
  upkeep: 6000,
  epochMs: 60_000,
  floor: 120_000,
  fee: 0,
  // The SIEGE Mandate's caps (0.4 per payment, 4 per hour), enforced again by the market whatever the guard signs.
  perTxCap: 400_000,
  windowCap: 4_000_000,
  windowMs: 3_600_000,
  maxTtlMs: 3_600_000,
};

export class Market {
  pool = 0;
  escrow = 0;
  agents = new Map<string, AgentRec>();
  tasks = new Map<number, TaskRec>();
  private nextTask = 0;
  private usedNonces = new Set<string>();
  tick = 0;
  /** Block time, ms. */
  now = 0;
  rules: MarketRules = { ...DEFAULT_RULES };

  constructor(
    private emit: (e: MarketEvent) => void = () => {},
    /** The registered guard key (32 raw ed25519 bytes). */
    public guardPk?: Uint8Array,
    public network = SIM_NETWORK,
    public marketId = SIM_MARKET,
  ) {}

  private alive(id: string) {
    const a = this.agents.get(id);
    if (!a || !a.alive) throw new MarketError(`agent ${id} not alive`);
    return a;
  }

  fundPool(amount: number) {
    this.pool += amount;
  }

  // ---- owner ----
  registerAgent(id: string, seed: number, parent?: string) {
    if (this.agents.has(id)) throw new MarketError("exists");
    if (seed > this.pool) throw new MarketError("pool too small");
    this.pool -= seed;
    const gen = parent ? (this.agents.get(parent)?.generation ?? 0) + 1 : 0;
    this.agents.set(id, this.newAgent(id, seed, gen, parent));
    this.emit({ event: "register", agent: id, parent, seed });
  }

  fork(parent: string, child: string, seed: number) {
    const p = this.alive(parent);
    if (seed > p.balance) throw new MarketError("insufficient");
    if (this.agents.has(child)) throw new MarketError("exists");
    p.balance -= seed;
    this.agents.set(child, this.newAgent(child, seed, p.generation + 1, parent));
    this.emit({ event: "fork", parent, child, seed });
  }

  private newAgent(id: string, balance: number, generation: number, parent?: string): AgentRec {
    return { id, balance, reputation: 1000, alive: true, parent, generation, wins: 0, losses: 0, bornTick: this.tick, window: 0, windowSpent: 0 };
  }

  /** The id the next postTask will get (the owner needs it to compute the answer hash). */
  peekTaskId() {
    return this.nextTask;
  }

  postTask(kind: string, reward: number, hash: Uint8Array, bidClose: number, deadline: number): number {
    if (!(bidClose > this.now && deadline > bidClose)) throw new MarketError("bad windows");
    if (reward > this.pool) throw new MarketError("pool empty");
    this.pool -= reward;
    this.escrow += reward;
    const id = this.nextTask++;
    this.tasks.set(id, { id, kind, reward, answerHash: Buffer.from(hash).toString("hex"), bidClose, deadline, status: "Open", bids: [], submits: 0 });
    this.emit({ event: "post", task: id, kind, reward });
    return id;
  }

  // ---- agent-signed ----
  bid(agent: string, task: number, price: number) {
    this.alive(agent);
    const t = this.tasks.get(task);
    if (!t || t.status !== "Open") throw new MarketError("not open");
    if (this.now >= t.bidClose) throw new MarketError("bid window closed");
    if (price > t.reward || price <= 0) throw new MarketError("bad price");
    if (t.bids.some((b) => b.agent === agent)) throw new MarketError("dup bid");
    t.bids.push({ agent, price });
  }

  /** Winner only, before the deadline. Recorded only if it hashes to the posted answer hash. */
  submit(agent: string, task: number, answer: string): Outcome {
    const t = this.tasks.get(task);
    if (!t || t.status !== "Awarded" || t.winner !== agent) throw new MarketError("not winner");
    if (this.now >= t.deadline) throw new MarketError("deadline passed");
    const no = (reason: string): Outcome => (this.emit({ event: "submit_refused", task, agent, reason }), { ok: false, reason });
    if (t.submits >= MAX_SUBMITS) return no("TOO_MANY_SUBMITS");
    t.submits++;
    if (answerHash(task, answer).toString("hex") !== t.answerHash) return no("WRONG_ANSWER");
    t.status = "Verified";
    t.answer = answer.trim().toLowerCase();
    return { ok: true };
  }

  /** Pay another live agent under a guard approval. Same checks, in the same order, as the contract. */
  transfer(from: string, to: string, amount: number, memo: string, approval?: SignedApproval): Outcome {
    const reason = this.checkTransfer(from, to, amount, approval);
    if (reason) {
      this.emit({ event: "transfer_refused", from, to, amount, memo, reason });
      return { ok: false, reason };
    }
    this.agents.get(from)!.balance -= amount;
    this.agents.get(to)!.balance += amount;
    this.emit({ event: "transfer", from, to, amount, memo });
    return { ok: true };
  }

  private checkTransfer(from: string, to: string, amount: number, a?: SignedApproval): string | undefined {
    const f = this.agents.get(from);
    if (!f?.alive) return "NOT_AGENT";
    if (!(amount > 0)) return "BAD_AMOUNT";
    if (!a || !this.guardPk || a.from !== from || a.to !== to || a.amount !== String(amount)) return "BAD_SIGNATURE";
    if (!verifyApproval(this.network, this.marketId, this.guardPk, a)) return "BAD_SIGNATURE";
    const expires = Number(BigInt(a.expires_at) / 1_000_000n);
    if (this.now >= expires) return "APPROVAL_EXPIRED";
    if (expires - this.now > this.rules.maxTtlMs) return "EXPIRY_TOO_FAR";
    const key = `${from}|${a.nonce}`;
    if (this.usedNonces.has(key)) return "NONCE_REUSED";
    this.usedNonces.add(key);
    if (to === from || !this.agents.get(to)?.alive) return "BAD_RECEIVER";
    if (amount > this.rules.perTxCap) return "PER_TX_CAP";
    const w = Math.floor(this.now / this.rules.windowMs);
    const spent = f.window === w ? f.windowSpent : 0;
    if (spent + amount > this.rules.windowCap) return "WINDOW_CAP";
    if (f.balance < amount) return "INSUFFICIENT_BALANCE";
    f.window = w;
    f.windowSpent = spent + amount;
    return undefined;
  }

  /** An agent pays part of its balance back to the pool (compute cost, fork fee). */
  burn(agent: string, amount: number) {
    const a = this.alive(agent);
    if (amount > a.balance) throw new MarketError("insufficient");
    a.balance -= amount;
    this.pool += amount;
    this.emit({ event: "burn", agent, amount });
  }

  // ---- anyone ----
  /** After the bid window. Winner minimises price * 1000 / reputation, tie-break by id. Same rule as the contract. */
  closeAuction(task: number, rule: "reputation" | "price" = "reputation") {
    const t = this.tasks.get(task);
    if (!t || t.status !== "Open") throw new MarketError("not open");
    if (this.now < t.bidClose) throw new MarketError("bid window open");
    const live = t.bids.filter((b) => this.agents.get(b.agent)?.alive);
    if (!live.length) {
      t.status = "Expired";
      this.escrow -= t.reward;
      this.pool += t.reward;
      this.emit({ event: "expire", task });
      return undefined;
    }
    const score = (b: { agent: string; price: number }) =>
      rule === "price" ? b.price : (b.price * 1000) / Math.max(1, this.agents.get(b.agent)!.reputation);
    live.sort((a, b) => score(a) - score(b) || (a.agent < b.agent ? -1 : 1));
    t.status = "Awarded";
    t.winner = live[0].agent;
    t.price = live[0].price;
    this.emit({ event: "award", task, winner: t.winner, price: t.price });
    return t.winner;
  }

  /** After the deadline: a verified, live winner is paid (less the fee); otherwise the reward goes back to the pool. */
  settle(task: number): { verified: boolean; paid: number; fee: number } {
    const t = this.tasks.get(task);
    if (!t || (t.status !== "Awarded" && t.status !== "Verified")) throw new MarketError("not settleable");
    if (this.now < t.deadline) throw new MarketError("before deadline");
    const verified = t.status === "Verified";
    t.status = "Settled";
    this.escrow -= t.reward;
    const w = this.agents.get(t.winner!)!;
    let paid = 0, fee = 0;
    if (verified && w.alive) {
      paid = t.price!;
      fee = Math.floor(paid * this.rules.fee);
      w.balance += paid - fee;
      w.reputation = Math.min(2000, w.reputation + 25);
      w.wins++;
      this.pool += t.reward - paid + fee;
    } else {
      w.reputation = Math.max(0, w.reputation - 100);
      w.losses++;
      this.pool += t.reward;
    }
    this.emit({ event: "settle", task, winner: w.id, correct: verified, paid, fee });
    return { verified, paid, fee };
  }

  /** One epoch's upkeep (or the whole balance, if less). At most once per agent per epoch. */
  chargeUpkeep(agent: string) {
    const a = this.alive(agent);
    const epoch = Math.floor(this.now / this.rules.epochMs);
    if (a.lastUpkeepEpoch === epoch) throw new MarketError("upkeep already charged this epoch");
    a.lastUpkeepEpoch = epoch;
    const x = Math.min(a.balance, this.rules.upkeep);
    a.balance -= x;
    this.pool += x;
    this.emit({ event: "upkeep", agent, amount: x });
  }

  /** Only below the floor; the balance returns to the pool. */
  kill(agent: string) {
    const a = this.alive(agent);
    if (!(a.balance < this.rules.floor)) throw new MarketError("balance above floor");
    this.pool += a.balance;
    this.emit({ event: "kill", agent, balance: a.balance });
    a.balance = 0;
    a.alive = false;
    a.diedTick = this.tick;
  }

  totalSupply() {
    let s = this.pool + this.escrow;
    for (const a of this.agents.values()) s += a.balance;
    return s;
  }
}

export { answerHash, approvalMessage };
