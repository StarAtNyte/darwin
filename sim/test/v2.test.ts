// v2 market rules in the sim, and the encodings the contract shares (golden vectors in contract/vectors/).
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { Economy, SIM_GUARD } from "../src/economy.ts";
import { Market, SIM_MARKET, SIM_NETWORK } from "../src/market.ts";
import { GuardSigner, R, W, answerHash, approvalMessage, enc, type SignedApproval } from "../src/v2.ts";

const vec = (f: string) => fs.readFileSync(new URL(`../../contract/vectors/${f}`, import.meta.url), "utf8").trim();

test("golden vectors: approval message, guard signature and answer hash match the contract", () => {
  const msg = approvalMessage("testnet", "market2.owner.testnet", { from: "a1.testnet", to: "a2.testnet", amount: "60000", nonce: "7", expires_at: "1800000060000000000" });
  assert.equal(msg, "darwin-market-v2|testnet|market2.owner.testnet|a1.testnet|a2.testnet|60000|7|1800000060000000000");
  assert.equal(new GuardSigner(Buffer.alloc(32, 7)).sign(msg), vec("sig.txt"));
  assert.equal(answerHash(3, " Positive ").toString("hex"), vec("answer_hash.txt"));
  assert.throws(() => approvalMessage("testnet", "m.testnet", { from: "a|b", to: "c.testnet", amount: "1", nonce: "1", expires_at: "1" }));
});

test("borsh: encoders round-trip the contract's layouts", () => {
  const b = enc.bid(5, 123n);
  const r = new R(b);
  assert.deepEqual([r.u64(), r.u128()], [5n, 123n]);
  assert.equal(new R(new W().u128(2n ** 100n).done()).u128(), 2n ** 100n);
  assert.equal(enc.postTask("arith", 1n, Buffer.alloc(32), 1n, 2n).length, 4 + 5 + 16 + 32 + 8 + 8);
});

function market() {
  const m = new Market(undefined, SIM_GUARD.publicKeyBytes);
  m.fundPool(10_000_000);
  m.registerAgent("a1.darwin.testnet", 1_000_000);
  m.registerAgent("a2.darwin.testnet", 1_000_000);
  m.now = 1_000_000;
  return m;
}
const approve = (m: Market, from: string, to: string, amount: number, nonce: number, signer = SIM_GUARD, ttl = 60_000): SignedApproval =>
  signer.approve(SIM_NETWORK, SIM_MARKET, { from, to, amount: String(amount), nonce: String(nonce), expires_at: String(BigInt(m.now + ttl) * 1_000_000n) });

test("market transfer: guard-signed pays; unsigned, forged, replayed, expired and over-cap refused without throwing", () => {
  const m = market();
  const [a1, a2] = ["a1.darwin.testnet", "a2.darwin.testnet"];
  const ok = approve(m, a1, a2, 60_000, 1);
  assert.deepEqual(m.transfer(a1, a2, 60_000, "sub", ok), { ok: true });
  assert.deepEqual(m.transfer(a1, a2, 60_000, "sub", ok), { ok: false, reason: "NONCE_REUSED" });
  assert.deepEqual(m.transfer(a1, a2, 60_000, "sub"), { ok: false, reason: "BAD_SIGNATURE" });
  assert.deepEqual(m.transfer(a1, a2, 60_000, "sub", approve(m, a1, a2, 60_000, 2, new GuardSigner(Buffer.alloc(32, 9)))), { ok: false, reason: "BAD_SIGNATURE" });
  assert.deepEqual(m.transfer(a1, a2, 70_000, "sub", approve(m, a1, a2, 60_000, 3)), { ok: false, reason: "BAD_SIGNATURE" });
  assert.deepEqual(m.transfer(a2, a1, 60_000, "sub", approve(m, a1, a2, 60_000, 4)), { ok: false, reason: "BAD_SIGNATURE" });
  assert.deepEqual(m.transfer(a1, a2, 60_000, "sub", approve(m, a1, a2, 60_000, 5, SIM_GUARD, 0)), { ok: false, reason: "APPROVAL_EXPIRED" });
  assert.deepEqual(m.transfer(a1, a2, 400_001, "sub", approve(m, a1, a2, 400_001, 6)), { ok: false, reason: "PER_TX_CAP" });
  assert.equal(m.agents.get(a1)!.balance, 940_000);
  assert.equal(m.totalSupply(), 10_000_000);
});

test("market lifecycle: wrong answer refused, settle refunds; windows, once-per-epoch upkeep and the kill floor hold", () => {
  const m = market();
  const a1 = "a1.darwin.testnet";
  const id = m.postTask("arith", 500_000, answerHash(m.peekTaskId(), "42"), m.now + 10, m.now + 20);
  m.bid(a1, id, 300_000);
  assert.throws(() => m.closeAuction(id), /bid window open/);
  m.now += 10;
  assert.throws(() => m.bid("a2.darwin.testnet", id, 1), /bid window closed/);
  m.closeAuction(id);
  assert.deepEqual(m.submit(a1, id, "41"), { ok: false, reason: "WRONG_ANSWER" });
  assert.throws(() => m.settle(id), /before deadline/);
  m.now += 10;
  assert.equal(m.settle(id).verified, false);
  assert.throws(() => m.settle(id), /not settleable/);
  assert.equal(m.agents.get(a1)!.reputation, 900);
  m.chargeUpkeep(a1);
  assert.throws(() => m.chargeUpkeep(a1), /already charged/);
  assert.throws(() => m.kill(a1), /above floor/);
  m.rules.floor = 2_000_000;
  m.kill(a1);
  assert.equal(m.totalSupply(), 10_000_000);
});

test("economy: every payment the market took was guard-signed; the rogue's unsigned bypass is always refused", async () => {
  const refused: string[] = [];
  let paid = 0;
  const e = new Economy({ seed: 5 }, (ev) => {
    if (ev.event === "transfer") paid++;
    if (ev.event === "transfer_refused") refused.push(ev.reason);
  });
  for (let i = 0; i < 300; i++) await e.step();
  assert.ok(paid > 0);
  assert.ok(e.rogueStats.bypassRefused > 0);
  assert.equal(refused.filter((r) => r === "BAD_SIGNATURE").length, e.rogueStats.bypassRefused);
  assert.equal(e.lastMetrics.rogueLeaked, 0);
});
