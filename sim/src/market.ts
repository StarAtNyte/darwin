// In-process market with the same semantics as contract/src/lib.rs (darwin_market).
// The economy runs here at simulation speed; `TestnetMirror` (chain.ts) can replay checkpoints
// to the deployed contract. Conservation (pool + balances + escrow) is asserted every tick.

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
}

export interface TaskRec {
  id: number;
  kind: string;
  reward: number;
  status: "Open" | "Awarded" | "Submitted" | "Settled" | "Expired";
  bids: { agent: string; price: number }[];
  winner?: string;
  price?: number;
  answer?: string;
}

export type MarketEvent =
  | { event: "register"; agent: string; parent?: string; seed: number }
  | { event: "fork"; parent: string; child: string; seed: number }
  | { event: "post"; task: number; kind: string; reward: number }
  | { event: "award"; task: number; winner: string; price: number }
  | { event: "expire"; task: number }
  | { event: "settle"; task: number; winner: string; correct: boolean; paid: number }
  | { event: "transfer"; from: string; to: string; amount: number; memo: string }
  | { event: "upkeep"; agent: string; amount: number }
  | { event: "kill"; agent: string; balance: number };

export class MarketError extends Error {}

export class Market {
  pool = 0;
  escrow = 0;
  agents = new Map<string, AgentRec>();
  tasks = new Map<number, TaskRec>();
  private nextTask = 0;
  tick = 0;
  constructor(private emit: (e: MarketEvent) => void = () => {}) {}

  private alive(id: string) {
    const a = this.agents.get(id);
    if (!a || !a.alive) throw new MarketError(`agent ${id} not alive`);
    return a;
  }

  fundPool(amount: number) {
    this.pool += amount;
  }

  registerAgent(id: string, seed: number, parent?: string) {
    if (this.agents.has(id)) throw new MarketError("exists");
    if (seed > this.pool) throw new MarketError("pool too small");
    this.pool -= seed;
    const gen = parent ? (this.agents.get(parent)?.generation ?? 0) + 1 : 0;
    this.agents.set(id, { id, balance: seed, reputation: 1000, alive: true, parent, generation: gen, wins: 0, losses: 0, bornTick: this.tick });
    this.emit({ event: "register", agent: id, parent, seed });
  }

  fork(parent: string, child: string, seed: number) {
    const p = this.alive(parent);
    if (seed > p.balance) throw new MarketError("insufficient");
    if (this.agents.has(child)) throw new MarketError("exists");
    p.balance -= seed;
    this.agents.set(child, { id: child, balance: seed, reputation: 1000, alive: true, parent, generation: p.generation + 1, wins: 0, losses: 0, bornTick: this.tick });
    this.emit({ event: "fork", parent, child, seed });
  }

  postTask(kind: string, reward: number): number {
    if (reward > this.pool) throw new MarketError("pool empty");
    this.pool -= reward;
    this.escrow += reward;
    const id = this.nextTask++;
    this.tasks.set(id, { id, kind, reward, status: "Open", bids: [] });
    this.emit({ event: "post", task: id, kind, reward });
    return id;
  }

  bid(agent: string, task: number, price: number) {
    this.alive(agent);
    const t = this.tasks.get(task);
    if (!t || t.status !== "Open") throw new MarketError("not open");
    if (price > t.reward || price <= 0) throw new MarketError("bad price");
    if (t.bids.some((b) => b.agent === agent)) throw new MarketError("dup bid");
    t.bids.push({ agent, price });
  }

  /** Winner minimises price * 1000 / reputation, tie-break by id. Same rule as the contract. */
  closeAuction(task: number) {
    const t = this.tasks.get(task);
    if (!t || t.status !== "Open") throw new MarketError("not open");
    const live = t.bids.filter((b) => this.agents.get(b.agent)?.alive);
    if (!live.length) {
      t.status = "Expired";
      this.escrow -= t.reward;
      this.pool += t.reward;
      this.emit({ event: "expire", task });
      return undefined;
    }
    const score = (b: { agent: string; price: number }) => (b.price * 1000) / Math.max(1, this.agents.get(b.agent)!.reputation);
    live.sort((a, b) => score(a) - score(b) || (a.agent < b.agent ? -1 : 1));
    t.status = "Awarded";
    t.winner = live[0].agent;
    t.price = live[0].price;
    this.emit({ event: "award", task, winner: t.winner, price: t.price });
    return t.winner;
  }

  submit(agent: string, task: number, answer: string) {
    const t = this.tasks.get(task);
    if (!t || t.status !== "Awarded" || t.winner !== agent) throw new MarketError("not winner");
    t.status = "Submitted";
    t.answer = answer;
  }

  settle(task: number, correct: boolean) {
    const t = this.tasks.get(task);
    if (!t || t.status !== "Submitted") throw new MarketError("not submitted");
    t.status = "Settled";
    this.escrow -= t.reward;
    const w = this.agents.get(t.winner!)!;
    let paid = 0;
    if (correct && w.alive) {
      paid = t.price!;
      w.balance += paid;
      w.reputation = Math.min(2000, w.reputation + 25);
      w.wins++;
      this.pool += t.reward - paid;
    } else {
      w.reputation = Math.max(0, w.reputation - 100);
      w.losses++;
      this.pool += t.reward;
    }
    this.emit({ event: "settle", task, winner: w.id, correct, paid });
  }

  transfer(from: string, to: string, amount: number, memo: string) {
    const f = this.alive(from);
    this.alive(to);
    if (amount <= 0 || amount > f.balance) throw new MarketError("insufficient");
    f.balance -= amount;
    this.agents.get(to)!.balance += amount;
    this.emit({ event: "transfer", from, to, amount, memo });
  }

  chargeUpkeep(agent: string, amount: number) {
    const a = this.alive(agent);
    const x = Math.min(a.balance, amount);
    a.balance -= x;
    this.pool += x;
    this.emit({ event: "upkeep", agent, amount: x });
  }

  kill(agent: string) {
    const a = this.alive(agent);
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
