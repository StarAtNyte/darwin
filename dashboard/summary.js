// One reading of the run per round. The headline, the status line, "Who is ahead" and the figures all take their
// counts and the leader's name from summarize(), so no two places on the page can disagree.
// A classic script (window.DarwinSummary); sim/test/summary.test.ts loads the same file in Node.
"use strict";
(function (root) {
  const short = (id) => (id ? String(id).replace(/\.darwin\.testnet$/, "") : "");
  const num = (id) => parseInt(short(id).replace(/\D/g, ""), 10) || 0;
  const fmt = (n) => Number(n).toLocaleString("en");
  const pct = (x) => `${Math.round(x * 100)}%`;

  /** The leader and the counts from one metrics row. A tie goes to the lowest-numbered founder, every time. */
  function summarize(m) {
    if (!m) return null;
    const lin = m.lineages || {};
    const fams = Object.keys(lin).sort((a, b) => num(a) - num(b) || (a < b ? -1 : 1));
    let population = 0, leader = null, leaderN = 0, tiedWith = 0;
    for (const f of fams) {
      const n = lin[f].n;
      population += n;
      if (n > leaderN) { leader = f; leaderN = n; tiedWith = 0; } else if (n === leaderN && n > 0) tiedWith++;
    }
    return {
      tick: m.tick,
      population,
      families: fams.length,
      deaths: m.deaths ?? 0,
      leader,
      leaderN,
      leaderShare: population ? leaderN / population : 0,
      tied: tiedWith > 0,
      share: (f) => (population ? (lin[f]?.n || 0) / population : 0),
    };
  }

  /** The one-line live status under the headline. */
  function statusLine(v) {
    if (!v) return "";
    return `Round ${fmt(v.tick)} · ${fmt(v.families)} ${v.families === 1 ? "family" : "families"} alive · largest ${pct(v.leaderShare)} · ${fmt(v.deaths)} died so far`;
  }

  /** Who leads, in words, from the same reading. */
  function leadSentence(v) {
    if (!v || !v.leader) return "No family is alive";
    if (v.leaderN > 1 && !v.tied) return `${short(v.leader)} leads with ${fmt(v.leaderN)} of ${fmt(v.population)} agents`;
    return `No family leads yet: the largest ${v.tied ? "are tied at" : "has"} ${fmt(v.leaderN)} of ${fmt(v.population)} agents`;
  }

  root.DarwinSummary = { summarize, statusLine, leadSentence, short };
})(typeof window !== "undefined" ? window : globalThis);
