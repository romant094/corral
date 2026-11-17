// An agent's reply, as Claude writes it (Markdown), made into rich messages (Bot API rich Markdown).
// Most of Claude's Markdown is rich Markdown already: headings, bold, italics, code, lists, tables, quotes.
// What changes: "<" outside code is escaped (rich Markdown takes some HTML tags), and a long reply folds:
// the opening stays in view, each "##" section becomes a <details> block named after it, and a closing question
// stays in view under them, so the person sees what the agent waits for.

// A reply shorter than this, or with fewer lines, is sent as it is.
export const FOLD_CHARS = 1200;
export const FOLD_LINES = 24;
// Under Telegram's limit of 32768 characters, with room for the folding tags.
export const PART_CHARS = 30000;

// Code fences and inline code keep their text; elsewhere "<" would open an HTML tag.
export function escapeText(md) {
  const out = [];
  let fence = null;
  for (const line of md.split("\n")) {
    const f = /^\s*(```+|~~~+)/.exec(line);
    if (fence) {
      out.push(line);
      if (f && f[1][0] === fence[0] && f[1].length >= fence.length) fence = null;
      continue;
    }
    if (f) { fence = f[1]; out.push(line); continue; }
    // Split on inline code spans; escape only outside them.
    // An HTML entity, not a backslash: rich Markdown shows "\<" as it is and drops a tag after it.
    out.push(line.split(/(`+[^`]*`+)/).map((part, i) => i % 2 ? part : part.replace(/&/g, "&amp;").replace(/</g, "&lt;")).join(""));
  }
  return out.join("\n");
}

// Blocks of text separated by blank lines, with a code fence always kept whole.
function paragraphs(md) {
  const blocks = [];
  let cur = [], fence = false;
  for (const line of md.split("\n")) {
    if (/^\s*(```|~~~)/.test(line)) fence = !fence;
    if (!fence && line.trim() === "" && cur.length) { blocks.push(cur.join("\n")); cur = []; continue; }
    if (fence || line.trim() !== "") cur.push(line);
  }
  if (cur.length) blocks.push(cur.join("\n"));
  return blocks;
}

const isHeading = (block) => /^#{1,6}\s+\S/.test(block);
const headingText = (block) => block.split("\n")[0].replace(/^#{1,6}\s+/, "").replace(/[*_`]/g, "").trim();
// A last paragraph that asks something: a line ending in "?", not inside code or a table.
const isQuestion = (block) => !/^\s*(```|\|)/.test(block) && /\?\s*$/.test(block.split("\n").pop());

const details = (summary, body) => `<details><summary>${summary}</summary>\n\n${body}\n</details>`;

// The reply as rich Markdown, folded when long.
// fold: the length in characters above which a reply folds (the Telegram settings' choice); 0 never folds.
export function foldReply(md, fold = FOLD_CHARS) {
  const text = escapeText(md.trim());
  const lines = Math.max(FOLD_LINES, Math.round(fold / 50));
  if (!fold || (text.length <= fold && text.split("\n").length <= lines)) return text;
  const blocks = paragraphs(text);
  const tail = blocks.length > 1 && isQuestion(blocks.at(-1)) ? blocks.pop() : null;
  // The opening: everything before the first heading, or the first paragraph when the reply starts with one.
  let i = blocks.findIndex(isHeading);
  if (i === -1) i = Math.min(1, blocks.length);
  if (i === 0) i = 1;
  const head = blocks.slice(0, i);
  const rest = blocks.slice(i);
  const sections = [];
  for (const b of rest) {
    if (isHeading(b)) sections.push({ title: headingText(b), body: [b.split("\n").slice(1).join("\n")].filter(Boolean) });
    else if (sections.length) sections.at(-1).body.push(b);
    else sections.push({ title: "Details", body: [b] });
  }
  const out = [...head];
  for (const s of sections) {
    if (s.body.length) out.push(details(s.title, s.body.join("\n\n")));
    else out.push(`## ${s.title}`);
  }
  if (tail) out.push(tail);
  return out.join("\n\n");
}

// The parts to send: a reply over Telegram's limit is cut at paragraph ends, each part folded on its own.
export const richParts = (md, { limit = PART_CHARS, fold = FOLD_CHARS } = {}) => splitParts(md, limit).map(p => foldReply(p, fold));

// A reply cut into parts of at most `limit` characters, at paragraph ends.
export function splitParts(md, limit) {
  const parts = [];
  let cur = "";
  for (const b of paragraphs(md.trim())) {
    if (cur && cur.length + b.length + 2 > limit) { parts.push(cur); cur = ""; }
    // One paragraph over the limit (a huge code block or log) is cut by lines; a cut code block is closed and
    // opened again, so the next part is still code.
    if (b.length > limit) {
      const open = /^\s*(```+|~~~+)/.exec(b)?.[0].trim() ?? null;
      for (const line of b.split("\n")) {
        if (cur && cur.length + line.length + 1 > limit - 8) {
          parts.push(open ? `${cur}\n${open.replace(/[^`~]/g, "")}` : cur);
          cur = open ? open : "";
        }
        cur = cur ? `${cur}\n${line}` : line;
      }
      continue;
    }
    cur = cur ? `${cur}\n\n${b}` : b;
  }
  if (cur) parts.push(cur);
  return parts;
}

// The "Markdown" format: a classic message, Claude's Markdown made into the HTML Telegram's
// parse_mode takes (b, i, s, code, pre, a, blockquote). Headings are bold lines, list items
// start with •, tables and code go as <pre>. A classic message holds 4096 characters.
export const HTML_PART_CHARS = 3500;
const esc = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

function inline(text) {
  // Code spans first: nothing inside them is formatting.
  const codes = [];
  let s = text.replace(/(`+)(?!`)([\s\S]*?[^`])\1(?!`)/g, (_, _ticks, code) => {
    codes.push(`<code>${esc(code)}</code>`);
    return `\u0000${codes.length - 1}\u0000`;
  });
  s = esc(s)
    .replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, (_, label, url) => `<a href="${url.replace(/"/g, "&quot;")}">${label}</a>`)
    .replace(/\*\*(?=\S)([\s\S]*?\S)\*\*/g, "<b>$1</b>")
    .replace(/__(?=\S)([\s\S]*?\S)__/g, "<b>$1</b>")
    // A single * or _ only between non-word characters: snake_case and 2*3*4 stay as they are.
    .replace(/(^|[^*\w])\*(?=\S)([^*]*?\S)\*(?![*\w])/g, "$1<i>$2</i>")
    .replace(/(^|[^_\w])_(?=\S)([^_]*?\S)_(?![_\w])/g, "$1<i>$2</i>")
    .replace(/~~(?=\S)([\s\S]*?\S)~~/g, "<s>$1</s>");
  return s.replace(/\u0000(\d+)\u0000/g, (_, i) => codes[Number(i)]);
}

export function markdownToHtml(md) {
  const out = [];
  let fence = null, lang = "", code = [], quote = [], table = [];
  const pre = (text, language = "") => language
    ? `<pre><code class="language-${language}">${esc(text)}</code></pre>` : `<pre>${esc(text)}</pre>`;
  const flush = () => {
    if (quote.length) { out.push(`<blockquote>${quote.join("\n")}</blockquote>`); quote = []; }
    if (table.length) { out.push(pre(table.join("\n"))); table = []; }
  };
  for (const line of md.split("\n")) {
    if (fence) {
      const f = /^\s*(```+|~~~+)\s*$/.exec(line);
      if (f && f[1][0] === fence[0] && f[1].length >= fence.length) { out.push(pre(code.join("\n"), lang)); fence = null; code = []; }
      else code.push(line);
      continue;
    }
    const f = /^\s*(```+|~~~+)\s*([\w+#-]*)/.exec(line);
    if (f) { flush(); fence = f[1]; lang = f[2]; continue; }
    if (/^\s*\|/.test(line)) { if (quote.length) flush(); table.push(line.trim()); continue; }
    const q = /^\s*>\s?(.*)$/.exec(line);
    if (q) { if (table.length) flush(); quote.push(inline(q[1])); continue; }
    flush();
    const h = /^#{1,6}\s+(.*?)\s*#*\s*$/.exec(line);
    if (h) { out.push(`<b>${inline(h[1])}</b>`); continue; }
    if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) { out.push("──────────"); continue; }
    const li = /^(\s*)[-*+]\s+(.*)$/.exec(line);
    if (li) { out.push(`${li[1]}• ${inline(li[2])}`); continue; }
    out.push(inline(line));
  }
  // A code block the cut left open still goes as code.
  if (fence) out.push(pre(code.join("\n"), lang));
  flush();
  return out.join("\n");
}
