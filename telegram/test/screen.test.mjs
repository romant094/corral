import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { mkdtemp, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseDialog, parseMenu, tailScreen } from "../dialog.mjs";
import { cleanTitle, projectOf } from "../herdr.mjs";
import { tabFor } from "../commands.mjs";
import { lastReply, lastReplyFrom } from "../transcript.mjs";
import { cleanName, inboxPath, fileOf } from "../files.mjs";
import { renderStatus, duration } from "../dashboard.mjs";
import { emptyState } from "../config.mjs";

const fixture = (name) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8");

test("permission prompt gives its three options", () => {
  assert.deepEqual(parseDialog(fixture("screens/permission.txt")).map(o => o.n), [1, 2, 3]);
  assert.equal(parseDialog(fixture("screens/permission.txt"))[0].label, "Yes");
});

test("question dialog skips the typed-text options", () => {
  const opts = parseDialog(fixture("screens/question.txt"));
  assert.deepEqual(opts.map(o => `${o.n}:${o.label}`), ["1:Daemon", "2:Mod only"]);
});

test("a numbered list in prose earlier on screen does not win over the dialog", () => {
  const screen = "Plan:\n1. Read\n2. Write\n3. Test\n\nDo you want to proceed?\n❯ 1. Yes\n  2. No\n";
  assert.deepEqual(parseDialog(screen).map(o => o.label), ["Yes", "No"]);
});

test("arrow menu: the trust question, but never Claude's input line", () => {
  const opts = parseMenu(fixture("screens/trust.txt"));
  assert.deepEqual(opts.map(o => [o.label, o.keys.join(" ")]), [["No, exit", "enter"], ["Yes, I trust this folder", "down enter"]]);
  const idle = "❯ fix the login\n──────\n  Opus 5.5 | Context: 4% | [x]\n  ⏵⏵ auto mode on\n";
  assert.equal(parseMenu(idle), null);
});

test("titles lose Claude's spinner; the default title counts as none", () => {
  assert.equal(cleanTitle("✳ Fix the login"), "Fix the login");
  assert.equal(cleanTitle("⠂ [WIP] Review"), "[WIP] Review");
  assert.equal(cleanTitle("Claude Code"), "");
  assert.equal(cleanTitle(undefined), "");
});

test("project: the space, or the folder for agents outside projects", () => {
  assert.equal(projectOf("corral / claude", "/p/corral"), "corral");
  assert.equal(projectOf("No project / 2", "/Users/me/Downloads", "/Users/me"), "Downloads");
  assert.equal(projectOf("No project / 2", "/Users/me", "/Users/me"), "~");
});

test("/new picks the tab with Claude agents, else the first", () => {
  const space = { tabs: [{ id: "a", root: { content: { terminal: "t1" } } }, { id: "b", root: { children: [{ content: { terminal: "t2" } }] } }] };
  assert.equal(tabFor(space, (t) => t === "t2"), "b");
  assert.equal(tabFor(space, () => false), "a");
  assert.equal(tabFor({ tabs: [] }, () => true), null);
});

test("no dialog, no buttons", () => {
  assert.equal(parseDialog("just output\n1. only one\n"), null);
  assert.equal(parseDialog(""), null);
});

test("tailScreen drops rules and trailing blanks", () => {
  assert.equal(tailScreen("a\n──────\nb\n\n\n", 5), "a\nb");
  assert.equal(tailScreen("1\n2\n3\n4", 2), "3\n4");
});

test("last reply is the last main-thread assistant text", () => {
  assert.equal(lastReplyFrom(fixture("transcript.jsonl")), "Done. All 12 tests pass.");
});

test("lastReply follows the statusline cache to the transcript", async () => {
  const dir = await mkdtemp(join(tmpdir(), "sess-"));
  const tr = join(dir, "t.jsonl");
  await writeFile(tr, fixture("transcript.jsonl"));
  await mkdir(join(dir, "sessions"));
  await writeFile(join(dir, "sessions", "42.json"), JSON.stringify({ transcript_path: tr }));
  assert.equal(await lastReply(42, join(dir, "sessions")), "Done. All 12 tests pass.");
  assert.equal(await lastReply(43, join(dir, "sessions")), null);
  assert.equal(await lastReply(null, join(dir, "sessions")), null);
});

test("file names cannot leave the inbox", () => {
  assert.equal(cleanName("../../etc/passwd"), "__.._etc_passwd");
  assert.equal(cleanName("..."), "file");
  assert.equal(cleanName("отчёт 2026.pdf"), "______2026.pdf");
  assert.equal(cleanName(".env"), "_env");
  const p = inboxPath("/in", "t1", "../x.png", Date.UTC(2026, 10, 16, 14, 5, 6));
  assert.equal(p, "/in/t1/20261116T140506-__x.png");
});

test("fileOf picks the largest photo size", () => {
  assert.deepEqual(fileOf({ photo: [{ file_id: "s", file_size: 1 }, { file_id: "l", file_size: 9 }] }), { id: "l", size: 9, name: "photo.jpg" });
  assert.equal(fileOf({ text: "x" }), null);
});

test("status lists agents with links and durations", () => {
  const state = emptyState();
  state.agents.t1 = { topic_id: 42, title: "[gmail] Fix login", state: "working" };
  const text = renderStatus([{ address: "t1", state: "working", where: "gmail / 1", project: "gmail", title: "Fix login", since: 0 }], state, -1001234, 125 * 60000);
  assert.equal(text, '<b>Agents (1)</b>\n⚡ <a href="https://t.me/c/1234/42">[gmail] Fix login</a> · working · 2 h 5 min');
  assert.equal(renderStatus([], state, -1), "<b>No live agents</b>");
  assert.equal(duration(30000), "now");
  assert.equal(duration(60 * 60000), "1 h");
});
