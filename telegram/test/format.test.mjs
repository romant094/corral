import { test } from "node:test";
import assert from "node:assert/strict";
import { escapeText, foldReply, richParts, FOLD_CHARS } from "../format.mjs";

test("escapeText: < outside code only", () => {
  assert.equal(escapeText("a < b & `x<y` here"), "a &lt; b &amp; `x<y` here");
  assert.equal(escapeText("```html\n<div>\n```\n<p>"), "```html\n<div>\n```\n&lt;p>");
});

test("the fold limit is the person's: 0 never folds, a low one folds early", () => {
  const md = "Opening.\n\n## Part\n\nBody text.";
  assert.equal(foldReply(md, 0), md);
  assert.match(foldReply(md, 10), /<details><summary>Part<\/summary>/);
  assert.equal(foldReply(md, 5000), md);
});

test("a short reply goes as it is", () => {
  assert.equal(foldReply("Done. **All** tests pass."), "Done. **All** tests pass.");
});

test("a long reply keeps its opening, folds each section, and keeps a closing question in view", () => {
  const long = "x".repeat(FOLD_CHARS);
  const md = [
    "Opening line.",
    "",
    "## What changed",
    "",
    `- one\n- two ${long}`,
    "",
    "## Checks",
    "",
    "```\nnode --test\n```",
    "",
    "Release it now?",
  ].join("\n");
  const out = foldReply(md);
  assert.ok(out.startsWith("Opening line.\n\n<details><summary>What changed</summary>"));
  assert.ok(out.includes("<details><summary>Checks</summary>\n\n```\nnode --test\n```\n</details>"));
  assert.ok(out.endsWith("</details>\n\nRelease it now?"));
});

test("a long reply without headings folds everything after its first paragraph", () => {
  const md = ["First paragraph.", ...Array.from({ length: 30 }, (_, i) => `Line ${i}`)].join("\n\n");
  const out = foldReply(md);
  assert.ok(out.startsWith("First paragraph.\n\n<details><summary>Details</summary>\n\nLine 0"));
});

test("richParts: a reply over the limit is cut at paragraphs, and a cut code block stays code", () => {
  const code = "```\n" + Array.from({ length: 50 }, (_, i) => `line ${i}`).join("\n") + "\n```";
  const parts = richParts(`Intro.\n\n${code}`, { limit: 200 });
  assert.ok(parts.length > 2);
  for (const p of parts.slice(1)) assert.match(p, /```/);
  for (const p of parts) assert.equal((p.match(/```/g) ?? []).length % 2, 0);
});
