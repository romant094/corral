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
  return buttons.length ? buttons.map(o => ({ ...o, keys: [String(o.n)] })) : null;
}

// A menu without numbers, moved through with arrows ("Do you trust this
// folder?"): the line with ❯ is the chosen one, its neighbours at the same
// indent are the others. Only a screen that says "Enter to confirm" counts, so
// Claude's input line (also ❯) is never read as a menu.
export function parseMenu(text) {
  const lines = String(text).split("\n");
  if (!lines.some(l => /Enter to (confirm|select)/i.test(l))) return null;
  let at = -1;
  for (let i = lines.length - 1; i >= 0; i--) if (/^\s*❯\s+\S/.test(lines[i]) && !OPTION.test(lines[i])) { at = i; break; }
  if (at < 0) return null;
  const col = lines[at].search(/❯\s+\S/);
  const textCol = col + lines[at].slice(col + 1).search(/\S/) + 1;
  const isOption = (l) => l.length > textCol && /^\s*$/.test(l.slice(0, textCol)) && /\S/.test(l[textCol]);
  let top = at, bottom = at;
  while (top > 0 && isOption(lines[top - 1])) top--;
  while (bottom < lines.length - 1 && isOption(lines[bottom + 1])) bottom++;
  if (bottom === top || bottom - top > 8) return null;
  const options = [];
  for (let i = top; i <= bottom; i++) {
    const label = lines[i].slice(textCol).trim();
    const moves = i - at;
    const step = moves < 0 ? "up" : "down";
    options.push({ n: options.length + 1, label, keys: [...Array(Math.abs(moves)).fill(step), "enter"] });
  }
  return options;
}

// Buttons for whatever the screen asks: a numbered dialog, else an arrow menu.
export const parseChoices = (text) => parseDialog(text) ?? parseMenu(text);
