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


  // Recorded runs kept at most this many characters of each reason (sim/src/mutator.ts used to cut there), so a
  // reason of exactly this length lost its end. We show it up to the last whole word and mark the cut with "…".
  const OLD_REASON_CAP = 160;
  const escH = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);

  const reasonRaw = (r) => String(r ?? "").replace(/<\/?[a-z]+\s*\/?>?/gi, "").replace(/[\s}]+$/, "").trim();

  /** A model's reason for display: stray markup removed, and a reason cut mid-word by the old cap ends at a word. */
  function quoteText(r) {
    let t = reasonRaw(r);
    const raw = String(r ?? "");
    if (raw.length !== OLD_REASON_CAP || /[.!?"”)]$/.test(t)) return { text: t, clipped: false };
    // Unless the cut fell on a space, the last fragment may be a partial word: drop it.
    const sp = t.lastIndexOf(" ");
    if (!/\s$/.test(raw) && sp > 0) t = t.slice(0, sp);
    t = t.replace(/[\s,;:–—-]+$/, "");
    // A trailing "and"/"so"/"the" reads as garbled; drop dangling joiners too.
    while (/\s(and|or|so|but|the|a|an|to|of|while|with|at|in|is|are|its)$/i.test(t)) t = t.replace(/\s\S+$/, "").replace(/[\s,;:]+$/, "");
    return { text: t + "…", clipped: true };
  }

  // Code names a model sometimes uses for the genes, mapped to the words the page uses. The raw words stay visible
  // on hover, so a quote is never silently changed.
  const TERMS = [
    [/\bfork_?at\b/gi, "fork threshold"],
    [/\bgini\b/gi, "wealth gap"],
    [/\bgenomes\b/gi, "strategies"],
    [/\bgenome\b/gi, "strategy"],
  ];

  /** HTML for a quote: plain words in place of code names, each marked, with the raw word in its title. */
  function quoteHtml(r) {
    const { text, clipped } = quoteText(r);
    const re = new RegExp(TERMS.map(([x]) => x.source).join("|"), "gi");
    let out = "", last = 0, m;
    while ((m = re.exec(text))) {
      const w = m[0];
      let plain = TERMS.find(([x]) => new RegExp(`^(?:${x.source})$`, "i").test(w))[1];
      if (/^\s*$|[.!?]\s+$/.test(text.slice(0, m.index))) plain = plain[0].toUpperCase() + plain.slice(1);
      out += escH(text.slice(last, m.index)) + `<span class="term" title="Claude wrote “${escH(w)}”">${escH(plain)}</span>`;
      last = m.index + w.length;
    }
    out += escH(text.slice(last));
    return { html: out, raw: reasonRaw(r), clipped, mapped: out.includes('class="term"') };
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

  root.DarwinSummary = { summarize, statusLine, leadSentence, short, quoteText, quoteHtml };
})(typeof window !== "undefined" ? window : globalThis);
