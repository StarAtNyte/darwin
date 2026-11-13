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
const { summarize, statusLine, leadSentence, quoteText, quoteHtml } = ctx.DarwinSummary;

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

test("a recorded reason cut at 160 characters ends at a whole word with an ellipsis, never mid-word", () => {
  const cut = "Parent holds 1.6 credits near fork threshold; reserve and forkAt are the only moves that matter here, and the genome is at its best-known point, so I keep it un";
  assert.equal(cut.length, 160);
  const q = quoteText(cut);
  assert.equal(q.clipped, true);
  assert.equal(q.text, "Parent holds 1.6 credits near fork threshold; reserve and forkAt are the only moves that matter here, and the genome is at its best-known point, so I keep it…");
  // A cut that fell on a space keeps the last word; a dangling "and" goes.
  assert.equal(quoteText("x".repeat(150) + " and slow ").text, "x".repeat(150) + " and slow…");
  assert.equal(quoteText("x".repeat(151) + " risk and").text, "x".repeat(151) + " risk…");
  // Shorter or complete reasons are untouched.
  assert.deepEqual({ ...quoteText("Lower markup to win more.") }, { text: "Lower markup to win more.", clipped: false });
  // Every recorded reason: no word is ever shown cut.
  const dir = path.join(here, "../../results/mutations");
  for (const f of fs.readdirSync(dir)) for (const e of Object.values<any>(JSON.parse(fs.readFileSync(path.join(dir, f), "utf8")).entries)) {
    const t = quoteText(e.rationale).text;
    if (e.rationale.length === 160) assert.ok(t.endsWith("…") || /[.!?]$/.test(t), t);
    const words = t.replace(/…$/, "").split(/\s+/);
    assert.ok(e.rationale.includes(words.join(" ")), "only the recorded words are shown");
    if (t.endsWith("…")) assert.match(e.rationale, new RegExp(words[words.length - 1].replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "[,;:–—-]*\\s"), "the last shown word was followed by a space, so it is whole");
  }
});

test("code names in a quote are shown in plain words, marked, with the raw word on hover", () => {
  const { html, raw, mapped } = quoteHtml("Genome is fine; raise forkAt while Gini < 0.5.");
  assert.equal(mapped, true);
  assert.equal(raw, "Genome is fine; raise forkAt while Gini < 0.5.");
  assert.equal(html, '<span class="term" title="Claude wrote “Genome”">Strategy</span> is fine; raise <span class="term" title="Claude wrote “forkAt”">fork threshold</span> while <span class="term" title="Claude wrote “Gini”">wealth gap</span> &lt; 0.5.');
  assert.equal(quoteHtml("plain words").mapped, false);
});
