// Read-only proof for the dashboard: a handful of the v2 market's testnet transactions (results/onchain-v2.json),
// each re-read from public testnet RPC so the panel shows what the chain recorded, not what we wrote down.
// No keys, no signing: only the `tx` RPC method. If RPC is unreachable, the committed record is served as is.
import fs from "node:fs";

type Recorded = { step: string; signer: string; method: string; hash: string; events?: string[]; result?: string };
export type ProofTx = { hash: string; label: string; method: string; event: string; reason: string | null; status: "final" | "recorded"; url: string };
export type Proof = { contract: string; contractUrl: string; source: "rpc" | "recorded"; checkedAt: string | null; txs: ProofTx[] };

// The lifecycle in order, picked by the recorded step text so no hash is typed by hand here.
const PICKS: { match: RegExp; label: string }[] = [
  { match: /^task 2: bid by a23\b/, label: "An agent bids with its own key" },
  { match: /^task 2: close auction/, label: "A third party closes the auction; the contract picks the winner" },
  { match: /^task 2: winner submits a wrong answer/, label: "A wrong answer is refused" },
  { match: /^task 2: settle/, label: "The winner is paid, less the 10% fee" },
  { match: /^the rogue payment the guard denied/, label: "A forged payment, with no guard signature, is rejected" },
  { match: /^replay of the guard's approval/, label: "A replayed approval is rejected" },
  { match: /^kill a6/, label: "A broke agent is removed; its balance returns to the pool" },
];

const RPCS = ["https://archival-rpc.testnet.fastnear.com", "https://rpc.testnet.fastnear.com"];
const TTL_MS = 6 * 3600_000;
const explorer = (h: string) => `https://testnet.nearblocks.io/txns/${h}`;

function firstEvent(logs: string[]): { event: string; reason: string | null } | null {
  for (const l of logs) {
    const j = l.startsWith("EVENT_JSON:") ? l.slice(11) : l;
    try {
      const e = JSON.parse(j);
      if (e.standard === "darwin") return { event: String(e.event), reason: e.data?.[0]?.reason ?? null };
    } catch {}
  }
  return null;
}

async function rpcTx(hash: string, signer: string): Promise<string[] | null> {
  for (const url of RPCS) {
    try {
      const r = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tx", params: { tx_hash: hash, sender_account_id: signer, wait_until: "NONE" } }),
        signal: AbortSignal.timeout(8000),
      });
      const j = await r.json();
      if (j.result?.receipts_outcome) return j.result.receipts_outcome.flatMap((o: { outcome: { logs: string[] } }) => o.outcome.logs);
    } catch {}
  }
  return null;
}

export function chainProof(file: string) {
  let rec: { marketId: string; txs: Recorded[] } | null = null;
  try {
    rec = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {}
  const picks = rec ? PICKS.map((p) => ({ ...p, tx: rec!.txs.find((t) => p.match.test(t.step)) })).filter((p) => p.tx) : [];
  const recorded = (): ProofTx[] => picks.map(({ label, tx }) => {
    const ev = firstEvent(tx!.events ?? []);
    return { hash: tx!.hash, label, method: tx!.method, event: ev?.event ?? tx!.method, reason: ev?.reason ?? null, status: "recorded", url: explorer(tx!.hash) };
  });
  let cache: Proof | null = null, at = 0, pending: Promise<Proof> | null = null;

  async function refresh(): Promise<Proof> {
    const base = { contract: rec!.marketId, contractUrl: `https://testnet.nearblocks.io/address/${rec!.marketId}` };
    const fallback = recorded();
    const txs = await Promise.all(picks.map(async ({ tx }, i) => {
      const logs = await rpcTx(tx!.hash, tx!.signer);
      if (!logs) return null;
      const ev = firstEvent(logs);
      return { ...fallback[i], event: ev?.event ?? tx!.method, reason: ev?.reason ?? null, status: "final" as const };
    }));
    const ok = txs.every(Boolean);
    return { ...base, source: ok ? "rpc" : "recorded", checkedAt: ok ? new Date().toISOString() : null, txs: ok ? (txs as ProofTx[]) : fallback };
  }

  return async function get(): Promise<Proof | null> {
    if (!rec || !picks.length) return null;
    if (cache && Date.now() - at < TTL_MS) return cache;
    pending ??= refresh().then((p) => {
      // A failed check is retried after a minute, not after the full TTL.
      cache = p;
      at = p.source === "rpc" ? Date.now() : Date.now() - TTL_MS + 60_000;
      return p;
    }).finally(() => (pending = null));
    return cache ?? pending;
  };
}
