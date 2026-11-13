// Live settler: while the public run plays, mirror its guard blocks on the v2 market on testnet.
//
// When the sim's guard blocks a rogue's payment, the settler sends the same payment to market2's transfer_internal
// with no guard signature. The contract refuses it (transfer_refused BAD_SIGNATURE) and logs the round in the memo,
// so each tx is a real, inspectable record of this run. It changes no state and stores nothing.
//
// Off unless DARWIN_SETTLER_ACCOUNT and DARWIN_SETTLER_KEY are set. The key is a FUNCTION-CALL access key on its own
// account (scripts/make-settler-key.sh), limited to market2 and the one method transfer_internal, with a gas
// allowance: it cannot move NEAR, deploy code or call anything else. Rate limited: one tx per interval, one in
// flight, a daily cap. The key is never logged.

export type SettlerEvent = { tick: number; seed: number; agent: string; to: string; amount: number; attack?: string };
export type Settled = { tick: number; seed: number; event: "guard_block"; agent: string; amount: number; hash: string; url: string; reason: string | null; at: string };
export type SendFn = (e: SettlerEvent, memo: string) => Promise<{ hash: string; reason: string | null }>;

export const memoFor = (e: SettlerEvent) => `round ${e.tick} seed ${e.seed} guard blocked ${e.agent.split(".")[0]}`.toLowerCase().replace(/[^a-z0-9 _-]/g, "").slice(0, 64);

export class Settler {
  readonly enabled: boolean;
  recent: Settled[] = [];
  lastError: string | null = null;
  private lastAt = -Infinity;
  private inFlight = false;
  private day = "";
  private today = 0;

  constructor(
    private send: SendFn | null,
    readonly opts: { minIntervalMs: number; maxPerDay: number; now?: () => number; onSettled?: (s: Settled) => void } = { minIntervalMs: 45_000, maxPerDay: 400 },
  ) {
    this.enabled = !!send;
  }

  private now() {
    return (this.opts.now ?? Date.now)();
  }

  /** Whether an event offered now would be sent. */
  ready(): boolean {
    if (!this.send || this.inFlight) return false;
    const t = this.now();
    if (t - this.lastAt < this.opts.minIntervalMs) return false;
    const d = new Date(t).toISOString().slice(0, 10);
    if (d !== this.day) (this.day = d), (this.today = 0);
    return this.today < this.opts.maxPerDay;
  }

  /** Offer one sim event. Sends it if the rate limit allows; never throws, never blocks the caller. */
  offer(e: SettlerEvent): Promise<Settled | null> | null {
    if (!this.ready()) return null;
    this.inFlight = true;
    this.lastAt = this.now();
    this.today++;
    return this.send!(e, memoFor(e))
      .then(({ hash, reason }) => {
        const s: Settled = { tick: e.tick, seed: e.seed, event: "guard_block", agent: e.agent, amount: e.amount, hash, url: `https://testnet.nearblocks.io/txns/${hash}`, reason, at: new Date(this.now()).toISOString() };
        this.recent.unshift(s);
        this.recent.length = Math.min(this.recent.length, 5);
        this.lastError = null;
        this.opts.onSettled?.(s);
        return s;
      })
      .catch((err: Error) => {
        // Errors never carry the key (it is not in any message we build), but keep them short.
        this.lastError = String(err?.message ?? err).slice(0, 160);
        return null;
      })
      .finally(() => (this.inFlight = false));
  }
}

/** The real sender: one transfer_internal call, unsigned by the guard, from the settler's function-call key. */
export async function nearSender(env: NodeJS.ProcessEnv, marketId: string): Promise<SendFn | null> {
  const id = env.DARWIN_SETTLER_ACCOUNT, key = env.DARWIN_SETTLER_KEY;
  if (!id || !key || !id.endsWith(".testnet") || !marketId) return null;
  const { Account, JsonRpcProvider, actions } = await import("near-api-js");
  const { enc, dec } = await import("./v2.ts");
  const provider = new JsonRpcProvider({ url: env.NEAR_RPC ?? "https://rpc.testnet.fastnear.com" });
  const acct = new Account(id, provider, key as `ed25519:${string}`);
  const to = env.DARWIN_SETTLER_TO ?? `a23-v2.${id.split(".").slice(1).join(".")}`;
  return async (e, memo) => {
    const nowNs = BigInt(Date.now()) * 1_000_000n;
    // The sim amount in micro-credits, at 1 credit = 1e-6 NEAR as in chain2.ts; at least 1 so the contract reaches the signature check.
    const amount = (BigInt(Math.max(1, Math.round(e.amount))) * 10n ** 12n).toString();
    const args = enc.transfer({ from: id, to, amount, nonce: String(Date.now()), expires_at: String(nowNs + 300n * 10n ** 9n), guard_sig: "" }, memo);
    const r: any = await acct.signAndSendTransaction({ receiverId: marketId, actions: [actions.functionCall("transfer_internal", args, 3n * 10n ** 12n, 0n)], throwOnFailure: false } as any);
    const hash: string = r?.transaction_outcome?.id ?? r?.transaction?.hash;
    if (!hash) throw new Error("no tx hash");
    if (r?.status?.Failure) throw new Error(`tx ${hash} failed`);
    const v = typeof r?.status?.SuccessValue === "string" ? dec.outcome(Buffer.from(r.status.SuccessValue, "base64")) : null;
    return { hash, reason: v && !v.ok ? (v.reason ?? null) : null };
  };
}
