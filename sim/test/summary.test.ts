// The dashboard's one source for counts and the leader (dashboard/summary.js), on real rounds of seed 3.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";
import { Economy } from "../src/economy.ts";

const here = path.dirname(fileURLToPath(import.meta.url));
const ctx: any = {};
vm.runInNewContext(fs.readFileSync(path.join(here, "../../dashboard/summary.js"), "utf8"), { globalThis: ctx });
const { summarize, statusLine, leadSentence } = ctx.DarwinSummary;

test("every count and the leader come from one metrics row and agree with each other", async () => {
  const e = new Economy({ seed: 3 });
  for (let i = 0; i < 300; i++) {
    await e.step();
    const m = e.lastMetrics;
    const v = summarize(m);
    assert.equal(v.population, m.population, `round ${m.tick}: population is the sum of the families`);
    assert.equal(v.families, m.dynasties);
    assert.equal(v.deaths, m.deaths);
    const max = Math.max(...Object.values(m.lineages).map((l) => l.n));
    assert.equal(v.leaderN, max);
    assert.equal(m.lineages[v.leader].n, max);
    assert.ok(Math.abs(v.leaderShare - m.topFamilyShare) < 1e-12, "largest share matches the sim's own");
    const line = statusLine(v);
    assert.equal(line, `Round ${m.tick} · ${m.dynasties} ${m.dynasties === 1 ? "family" : "families"} alive · largest ${Math.round(m.topFamilyShare * 100)}% · ${m.deaths} died so far`);
    const lead = leadSentence(v);
    if (v.leaderN > 1 && !v.tied) assert.equal(lead, `${v.leader.replace(".darwin.testnet", "")} leads with ${v.leaderN} of ${m.population} agents`);
    else assert.match(lead, new RegExp(`^No family leads yet: .* ${v.leaderN} of ${m.population} agents$`));
  }
});

test("a tie never names a leader, and the same row always gives the same leader", () => {
  const m = { tick: 9, deaths: 0, lineages: { "a7.darwin.testnet": { n: 2 }, "a3.darwin.testnet": { n: 2 }, "a10.darwin.testnet": { n: 1 } } };
  const v = summarize(m);
  assert.equal(v.leader, "a3.darwin.testnet", "lowest-numbered founder on a tie");
  assert.equal(v.tied, true);
  assert.equal(leadSentence(v), "No family leads yet: the largest are tied at 2 of 5 agents");
  const flipped = { ...m, lineages: Object.fromEntries(Object.entries(m.lineages).reverse()) };
  assert.equal(summarize(flipped).leader, v.leader, "key order does not matter");
  assert.equal(statusLine(v), "Round 9 · 3 families alive · largest 40% · 0 died so far");
});
