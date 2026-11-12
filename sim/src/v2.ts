// DARWIN market v2: the pieces the sim, the chain scripts and the contract must agree on byte for byte.
//
// Guard approval (same scheme as the SIEGE vault, ../siege/contract): the guard holds its own ed25519 key; when the
// Mandate guard allows a payment it signs
//   darwin-market-v2|<network>|<market id>|<from>|<to>|<amount>|<nonce>|<expires_at ns>
// and the contract's transfer_internal checks it with env::ed25519_verify against the registered guard key.
// Account ids cannot contain "|" and the other fields are decimal digits, so the encoding is unambiguous.
//
// Answer hash: sha256(task_id as u64 little endian || canonical answer), canonical = trimmed, lower case.
//
// Arguments and results are Borsh (contract/src/lib.rs). Golden vectors: contract/vectors/, checked by both sides.
import crypto from "node:crypto";

export const MESSAGE_TAG = "darwin-market-v2";

export const canonicalAnswer = (a: string) => a.trim().toLowerCase();

export function answerHash(taskId: number | bigint, answer: string): Buffer {
  const id = Buffer.alloc(8);
  id.writeBigUInt64LE(BigInt(taskId));
  return crypto.createHash("sha256").update(id).update(canonicalAnswer(answer), "utf8").digest();
}

export interface Approval {
  from: string;
  to: string;
  /** Ledger units, decimal string. */
  amount: string;
  /** u64, decimal string; single use per paying agent. */
  nonce: string;
  /** Block time in ns, decimal string; invalid at or after it. */
  expires_at: string;
}
export interface SignedApproval extends Approval {
  /** base64 of the 64-byte ed25519 signature. */
  guard_sig: string;
}

const DEC = /^(0|[1-9][0-9]*)$/;
const ACCOUNT = /^[a-z0-9._-]{2,64}$/;
export function approvalMessage(network: string, contractId: string, a: Approval): string {
  for (const [k, v] of Object.entries({ amount: a.amount, nonce: a.nonce, expires_at: a.expires_at })) if (!DEC.test(v)) throw new Error(`${k} must be a decimal integer string`);
  for (const id of [contractId, a.from, a.to]) if (!ACCOUNT.test(id)) throw new Error("bad account id");
  if (!/^[a-z0-9-]{1,32}$/.test(network)) throw new Error("bad network tag");
  return [MESSAGE_TAG, network, contractId, a.from, a.to, a.amount, a.nonce, a.expires_at].join("|");
}

const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
export function base58(bytes: Uint8Array): string {
  let n = BigInt("0x" + (Buffer.from(bytes).toString("hex") || "0"));
  let out = "";
  while (n > 0n) {
    out = B58[Number(n % 58n)] + out;
    n /= 58n;
  }
  for (const b of bytes) {
    if (b !== 0) break;
    out = "1" + out;
  }
  return out;
}
export function unbase58(s: string): Buffer {
  let n = 0n;
  for (const ch of s) {
    const i = B58.indexOf(ch);
    if (i < 0) throw new Error("bad base58");
    n = n * 58n + BigInt(i);
  }
  let hex = n.toString(16);
  if (hex.length % 2) hex = "0" + hex;
  const body = n === 0n ? Buffer.alloc(0) : Buffer.from(hex, "hex");
  let zeros = 0;
  while (s[zeros] === "1") zeros++;
  return Buffer.concat([Buffer.alloc(zeros), body]);
}

const PKCS8_ED25519 = Buffer.from("302e020100300506032b657004220420", "hex");
const SPKI_ED25519 = Buffer.from("302a300506032b6570032100", "hex");

/** The guard's signing key: a NEAR-format secret ("ed25519:<base58 of seed||pub>") or a 32-byte seed. */
export class GuardSigner {
  private key: crypto.KeyObject;
  readonly publicKeyBytes: Buffer;

  constructor(secret: string | Uint8Array) {
    let seed: Buffer;
    if (typeof secret === "string") {
      const raw = unbase58(secret.replace(/^ed25519:/, ""));
      if (raw.length !== 64 && raw.length !== 32) throw new Error("guard key must be an ed25519 secret");
      seed = raw.subarray(0, 32);
    } else seed = Buffer.from(secret);
    if (seed.length !== 32) throw new Error("guard seed must be 32 bytes");
    this.key = crypto.createPrivateKey({ key: Buffer.concat([PKCS8_ED25519, seed]), format: "der", type: "pkcs8" });
    this.publicKeyBytes = Buffer.from(crypto.createPublicKey(this.key).export({ format: "der", type: "spki" })).subarray(-32);
  }

  static generate(): { signer: GuardSigner; secret: string } {
    const seed = crypto.randomBytes(32);
    const s = new GuardSigner(seed);
    return { signer: s, secret: `ed25519:${base58(Buffer.concat([seed, s.publicKeyBytes]))}` };
  }

  get publicKey(): string {
    return `ed25519:${base58(this.publicKeyBytes)}`;
  }

  sign(message: string): string {
    return crypto.sign(null, Buffer.from(message, "utf8"), this.key).toString("base64");
  }

  approve(network: string, contractId: string, a: Approval): SignedApproval {
    return { ...a, guard_sig: this.sign(approvalMessage(network, contractId, a)) };
  }
}

const pubKeys = new Map<string, crypto.KeyObject>();

/** What the contract does with env::ed25519_verify. */
export function verifyApproval(network: string, contractId: string, publicKeyBytes: Uint8Array, a: SignedApproval): boolean {
  try {
    const sig = Buffer.from(a.guard_sig, "base64");
    if (sig.length !== 64) return false;
    const hex = Buffer.from(publicKeyBytes).toString("hex");
    let pub = pubKeys.get(hex);
    if (!pub) pubKeys.set(hex, (pub = crypto.createPublicKey({ key: Buffer.concat([SPKI_ED25519, Buffer.from(publicKeyBytes)]), format: "der", type: "spki" })));
    return crypto.verify(null, Buffer.from(approvalMessage(network, contractId, a), "utf8"), pub, sig);
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------- Borsh

export class W {
  private parts: Buffer[] = [];
  u8(n: number) { this.parts.push(Buffer.from([n])); return this; }
  bool(b: boolean) { return this.u8(b ? 1 : 0); }
  u16(n: number) { const b = Buffer.alloc(2); b.writeUInt16LE(n); this.parts.push(b); return this; }
  u32(n: number) { const b = Buffer.alloc(4); b.writeUInt32LE(n); this.parts.push(b); return this; }
  u64(n: bigint | number) { const b = Buffer.alloc(8); b.writeBigUInt64LE(BigInt.asUintN(64, BigInt(n))); this.parts.push(b); return this; }
  u128(n: bigint | string) { const v = BigInt(n); if (v < 0n || v >= 1n << 128n) throw new Error("u128 out of range"); const b = Buffer.alloc(16); b.writeBigUInt64LE(v & ((1n << 64n) - 1n)); b.writeBigUInt64LE(v >> 64n, 8); this.parts.push(b); return this; }
  fixed(x: Uint8Array) { this.parts.push(Buffer.from(x)); return this; }
  bytes(x: Uint8Array) { this.u32(x.length); return this.fixed(x); }
  str(s: string) { return this.bytes(Buffer.from(s, "utf8")); }
  optStr(s?: string | null) { return s == null ? this.u8(0) : this.u8(1).str(s); }
  /** near_sdk::PublicKey: Vec<u8> of curve byte (0 = ed25519) + 32 key bytes. */
  pk(near: string) { const raw = unbase58(near.replace(/^ed25519:/, "")); if (raw.length !== 32) throw new Error("ed25519 public key expected"); return this.bytes(Buffer.concat([Buffer.from([0]), raw])); }
  done(): Uint8Array { return new Uint8Array(Buffer.concat(this.parts)); }
}

export class R {
  private o = 0;
  private b: Buffer;
  constructor(b: Uint8Array) { this.b = Buffer.from(b); }
  u8() { return this.b[this.o++]; }
  bool() { return this.u8() === 1; }
  u16() { const v = this.b.readUInt16LE(this.o); this.o += 2; return v; }
  u32() { const v = this.b.readUInt32LE(this.o); this.o += 4; return v; }
  u64() { const v = this.b.readBigUInt64LE(this.o); this.o += 8; return v; }
  u128() { const lo = this.b.readBigUInt64LE(this.o), hi = this.b.readBigUInt64LE(this.o + 8); this.o += 16; return lo + (hi << 64n); }
  fixed(n: number) { const v = this.b.subarray(this.o, this.o + n); this.o += n; return v; }
  bytes() { return this.fixed(this.u32()); }
  str() { return this.bytes().toString("utf8"); }
  opt<T>(f: () => T): T | undefined { return this.u8() === 1 ? f() : undefined; }
}

export interface Rules { upkeep: bigint; epochNs: bigint; floor: bigint; feeBps: number; perTxCap: bigint; windowCap: bigint; windowNs: bigint; maxTtlNs: bigint }
const rules = (w: W, r: Rules) => w.u128(r.upkeep).u64(r.epochNs).u128(r.floor).u16(r.feeBps).u128(r.perTxCap).u128(r.windowCap).u64(r.windowNs).u64(r.maxTtlNs);

export const enc = {
  init: (owner: string, guardPk: string, network: string, r: Rules) => rules(new W().str(owner).pk(guardPk).str(network), r).done(),
  setRules: (r: Rules) => rules(new W(), r).done(),
  register: (agent: string, parent: string | null, seed: bigint) => new W().str(agent).optStr(parent).u128(seed).done(),
  fork: (parent: string, child: string, seed: bigint) => new W().str(parent).str(child).u128(seed).done(),
  postTask: (kind: string, reward: bigint, hash: Uint8Array, bidCloseNs: bigint, deadlineNs: bigint) => new W().str(kind).u128(reward).fixed(hash).u64(bidCloseNs).u64(deadlineNs).done(),
  bid: (taskId: bigint | number, price: bigint) => new W().u64(taskId).u128(price).done(),
  taskId: (taskId: bigint | number) => new W().u64(taskId).done(),
  submit: (taskId: bigint | number, answer: string) => new W().u64(taskId).str(answer).done(),
  transfer: (a: SignedApproval, memo: string) => new W().str(a.to).u128(a.amount).str(memo).u64(BigInt(a.nonce)).u64(BigInt(a.expires_at)).bytes(Buffer.from(a.guard_sig, "base64")).done(),
  account: (id: string) => new W().str(id).done(),
  u128: (n: bigint) => new W().u128(n).done(),
  nonceUsed: (agent: string, nonce: bigint) => new W().str(agent).u64(nonce).done(),
};

export const dec = {
  outcome(b: Uint8Array) { const r = new R(b); const ok = r.bool(); const reason = r.opt(() => r.str()); return { ok, ...(reason ? { reason } : {}) }; },
  u64: (b: Uint8Array) => new R(b).u64(),
  u128: (b: Uint8Array) => new R(b).u128(),
  bool: (b: Uint8Array) => new R(b).bool(),
  agent(b: Uint8Array) {
    const r = new R(b);
    return r.opt(() => ({
      balance: r.u128(), reputation: r.u32(), alive: r.bool(), parent: r.opt(() => r.str()), generation: r.u32(), wins: r.u32(), losses: r.u32(),
      lastUpkeepEpoch: r.opt(() => r.u64()), window: r.u64(), windowSpent: r.u128(),
    }));
  },
  task(b: Uint8Array) {
    const r = new R(b);
    const STATUS = ["Open", "Awarded", "Verified", "Settled", "Expired"] as const;
    return r.opt(() => ({
      kind: r.str(), reward: r.u128(), answerHash: r.fixed(32).toString("hex"), bidCloseNs: r.u64(), deadlineNs: r.u64(), status: STATUS[r.u8()],
      bids: Array.from({ length: r.u32() }, () => ({ agent: r.str(), price: r.u128() })),
      winner: r.opt(() => r.str()), price: r.u128(), answer: r.opt(() => r.str()), submits: r.u8(),
    }));
  },
};
