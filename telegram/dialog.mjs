// Reading a terminal screen: the tail worth posting, and the numbered dialog
// at its bottom (Claude Code's permission prompts and questions).

// Rule lines (the input frame's ─────) carry nothing on a phone.
const RULE = /^[\s─━═—-]+$/;

export function tailScreen(text, n) {
  const lines = String(text).split("\n").map(l => l.trimEnd()).filter(l => !RULE.test(l) || l === "");
  while (lines.length && lines.at(-1) === "") lines.pop();
  return lines.slice(-n).join("\n");
}

// Options Claude Code shows but that want typed text, not a key: no button.
const TEXT_ONLY = /^(Type something|Chat about this)/i;

const OPTION = /^\s*(?:[❯›>]\s*)?(\d)\.\s+(\S.*?)\s*$/;

// The last run of options numbered 1, 2, 3… on the screen, 2 to 9 long.
// Description lines between options are allowed; a number out of order starts over.
export function parseDialog(text) {
  let best = null, cur = null;
  for (const line of String(text).split("\n")) {
    const m = OPTION.exec(line);
    if (!m) continue;
    const n = Number(m[1]);
    if (n === 1) cur = [{ n, label: m[2] }];
    else if (cur && n === cur.at(-1).n + 1) cur.push({ n, label: m[2] });
    else { cur = null; continue; }
    if (cur.length >= 2) best = cur;
  }
  if (!best || best.length > 9) return null;
  const buttons = best.filter(o => !TEXT_ONLY.test(o.label));
  return buttons.length ? buttons : null;
}
