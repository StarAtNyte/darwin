// Links from the dashboard and docs into this repo's markdown must land on a heading that exists.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const read = (f: string) => fs.readFileSync(path.join(root, f), "utf8");

// GitHub's heading slug: lower case, punctuation dropped (hyphens and underscores kept), spaces to hyphens.
const slug = (h: string) => h.trim().toLowerCase().replace(/[`*]/g, "").replace(/[^\p{L}\p{N}\s_-]/gu, "").replace(/\s/g, "-");
const anchors = (md: string) => new Set([...md.matchAll(/^#{1,6}\s+(.+)$/gm)].map((m) => slug(m[1])));

test("repo links with an #anchor point at a heading that exists", () => {
  const sources = ["dashboard/index.html", "dashboard/app.js", "dashboard/404.html", "README.md", "CLAIMS.md", "docs/TESTNET.md"];
  const bad: string[] = [];
  let checked = 0;
  for (const src of sources) {
    const text = read(src);
    const links = [
      ...[...text.matchAll(/https:\/\/github\.com\/StarAtNyte\/darwin(?:\/blob\/main\/([\w./-]+\.md))?#([\w-]+)/g)].map((m) => [m[1] ?? "README.md", m[2]]),
      ...(src.endsWith(".md") ? [...text.matchAll(/\]\(((?:[\w./-]+\.md)?)#([\w-]+)\)/g)].map((m) => [m[1] ? path.join(path.dirname(src), m[1]) : src, m[2]]) : []),
    ];
    for (const [file, anchor] of links) {
      checked++;
      if (!anchors(read(file)).has(anchor)) bad.push(`${src}: ${file}#${anchor}`);
    }
  }
  assert.ok(checked > 5, "found the links");
  assert.deepEqual(bad, []);
});
