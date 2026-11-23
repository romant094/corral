import { test } from "node:test";
import assert from "node:assert/strict";
import { makeSync, topicName, pickIcons, resumedSession } from "../agents.mjs";
import { world, term, status } from "./helpers.mjs";

const tick = () => new Promise(r => setTimeout(r, 5));

function setup(opts) {
  const w = world(opts);
  const icons = Object.fromEntries(["starting", "working", "blocked", "done", "idle", "ended"].map(k => [k, `i-${k}`]));
  const sync = makeSync({ ...w, icons, throttleMs: 0, blockedDelayMs: 0, replyRetryMs: 0, sessionRetryMs: 0, startCheckMs: 1, ...opts?.sync });
  const feed = async (msg) => { for (const c of w.herd.apply(msg)) await sync.handle(c); await tick(); };
  return { ...w, sync, feed };
}

test("a status change with the same name edits the icon only", async () => {
  const s = setup();
  await s.feed({ terminals: [term("t1")] });
  await s.feed(status("t1", "working"));
  await tick();
  assert.deepEqual(s.api.of("editForumTopic").at(-1).params, { chat_id: -1001, message_thread_id: 101, icon_custom_emoji_id: "i-working" });
});

test("an icon recorded before icon_ok is sent once more after a restart", async () => {
  const s = setup();
  s.state.agents.t1 = { topic_id: 55, title: "[t1] new session", icon: "i-idle", state: "idle" };
  await s.feed({ terminals: [term("t1")] });
  await tick();
  assert.deepEqual(s.api.of("editForumTopic").map(c => c.params), [{ chat_id: -1001, message_thread_id: 55, icon_custom_emoji_id: "i-idle" }]);
  assert.equal(s.state.agents.t1.icon_ok, true);
});

test("an icon Telegram calls not modified is bounced so clients see it", async () => {
  const s = setup();
  s.state.agents.t1 = { topic_id: 55, title: "[t1] new session", icon: "i-idle", state: "idle" };
  const call = s.api.call;
  let first = true;
  s.api.call = async (m, p) => {
    if (m === "editForumTopic" && first) { first = false; throw new Error("editForumTopic: 400 Bad Request: TOPIC_NOT_MODIFIED"); }
    return call(m, p);
  };
  await s.feed({ terminals: [term("t1")] });
  await tick();
  const edits = s.api.of("editForumTopic").map(c => c.params.icon_custom_emoji_id);
  assert.equal(edits.length, 2);
  assert.notEqual(edits[0], "i-idle");
  assert.equal(edits[1], "i-idle");
  assert.equal(s.state.agents.t1.icon_ok, true);
  assert.deepEqual(s.logs.filter(l => /rename/.test(l) && /NOT_MODIFIED/.test(l)), []);
});

test("done waits for a reply that is new, not the previous turn's", async () => {
  const replies = ["Old answer.", "Old answer.", "New answer."];
  const s = setup({ sync: { lastReply: async () => replies.shift() ?? "New answer." } });
  await s.feed({ terminals: [term("t1", "working")] });
  // The first turn posts "Old answer."; the second sees it twice before the new one lands.
  await s.feed(status("t1", "done"));
  await s.feed(status("t1", "working"));
  await s.feed(status("t1", "done"));
  const texts = s.api.of("sendRichMessage").map(c => c.params.rich_message.markdown).filter(t => /answer/.test(t));
  assert.deepEqual(texts, ["Old answer.", "New answer."]);
});

test("topic name is [project] title, cut to 128", () => {
  assert.equal(topicName("corral", "Telegram bridge"), "[corral] Telegram bridge");
  assert.equal(topicName("corral", ""), "[corral] new session");
  assert.equal(topicName("x", "y".repeat(300)).length, 128);
});

test("icons: each status takes the first emoji Telegram's set has", () => {
  const icons = pickIcons([{ emoji: "⚡️", custom_emoji_id: "w" }, { emoji: "💬", custom_emoji_id: "c" }, { emoji: "✅", custom_emoji_id: "d" }, { emoji: "🏆", custom_emoji_id: "t" }]);
  assert.equal(icons.working, "w");
  assert.equal(icons.idle, "c");     // no ☕ in this set: the stand-in
  assert.equal(icons.done, "d");
  assert.equal(icons.ended, "t");
  assert.equal(icons.blocked, null);
});

test("a new agent gets one topic and a start line", async () => {
  const s = setup();
  await s.feed({ terminals: [term("t1")] });
  assert.equal(s.api.of("createForumTopic").length, 1);
  assert.deepEqual(s.api.of("createForumTopic")[0].params, { chat_id: -1001, name: "[t1] new session", icon_custom_emoji_id: "i-idle" });
  assert.match(s.api.of("sendMessage")[0].params.text, /Started in <code>\/p\/t1<\/code>/);
  assert.equal(s.state.agents.t1.topic_id, 101);
});

test("a known agent reuses its topic after a restart", async () => {
  const s = setup();
  s.state.agents.t1 = { topic_id: 55, title: "[t1] new session", icon: "i-idle", state: "idle" };
  await s.feed({ terminals: [term("t1")] });
  assert.equal(s.api.of("createForumTopic").length, 0);
});

test("status change renames; done posts the last reply", async () => {
  const s = setup({ reply: "All tests pass." });
  await s.feed({ terminals: [term("t1")] });
  await s.feed(status("t1", "working"));
  await s.feed(status("t1", "done"));
  await tick();
  const icons = s.api.of("editForumTopic").map(c => c.params.icon_custom_emoji_id);
  assert.ok(icons.includes("i-done") || icons.includes("i-working"));
  const texts = s.api.of("sendRichMessage").map(c => c.params.rich_message.markdown);
  assert.ok(texts.includes("All tests pass."));
});

test("a rich message Telegram refuses goes as plain text; a long reply is split", async () => {
  const s = setup({ reply: "# Done\n\n**All** good." });
  const call = s.api.call;
  s.api.call = async (m, p) => {
    if (m === "sendRichMessage") throw new Error("sendRichMessage: 400 Bad Request: can't parse rich message");
    return call(m, p);
  };
  await s.feed({ terminals: [term("t1", "working")] });
  await s.feed(status("t1", "done"));
  assert.ok(s.api.of("sendMessage").some(c => c.params.text === "# Done\n\n**All** good."));
});

test("the format is read at each reply: Markdown goes as a classic formatted message", async () => {
  let format = { reply_format: "rich", fold_chars: 1200 };
  const s = setup({ reply: "# Done\n\n**All** good.", sync: { formatting: async () => format } });
  await s.feed({ terminals: [term("t1", "working")] });
  format = { reply_format: "markdown", fold_chars: 1200 };
  await s.feed(status("t1", "done"));
  assert.equal(s.api.of("sendRichMessage").length, 0);
  assert.ok(s.api.of("sendMessage").some(c => c.params.text === "<b>Done</b>\n\n<b>All</b> good."));
});

test("done without a transcript posts the screen tail", async () => {
  const s = setup({ screen: "line a\n────\nline b\n\n", reply: null });
  await s.feed({ terminals: [term("t1", "working")] });
  await s.feed(status("t1", "done"));
  const last = s.api.of("sendMessage").at(-1).params.text;
  assert.equal(last, "<pre>line a\nline b</pre>");
});

test("blocked posts the screen with option buttons", async () => {
  const screen = " Do you want to proceed?\n ❯ 1. Yes\n   2. No, and tell Claude what to do differently (esc)\n";
  const s = setup({ screen });
  await s.feed({ terminals: [term("t1", "working")] });
  await s.feed(status("t1", "blocked"));
  await tick();
  const post = s.api.of("sendMessage").at(-1).params;
  assert.match(post.text, /Waiting for you/);
  const labels = post.reply_markup.inline_keyboard.map(r => r[0].text);
  assert.deepEqual(labels, ["1 · Yes", "2 · No, and tell Claude what to do differently (esc)"]);
  const entry = s.buttons.get(post.reply_markup.inline_keyboard[0][0].callback_data);
  assert.equal(entry.type, "opt");
  assert.equal(s.sync.questions.get("t1").qid, entry.qid);
});

test("an agent that ends gets 🏁, a Delete topic button, a closed topic and an ended entry", async () => {
  const s = setup();
  await s.feed({ terminals: [term("t1")] });
  await s.feed({ method: "event", params: { type: "finished", terminal: "t1", data: {} } });
  assert.deepEqual(s.api.of("editForumTopic").at(-1).params, { chat_id: -1001, message_thread_id: 101, icon_custom_emoji_id: "i-ended" });
  const post = s.api.of("sendMessage").at(-1).params;
  assert.equal(post.text, "🏁 Agent ended");
  assert.equal(s.buttons.get(post.reply_markup.inline_keyboard[0][0].callback_data).type, "deltopic");
  assert.equal(s.api.of("closeForumTopic").length, 1);
  assert.deepEqual(s.state.ended.map(e => e.topic_id), [101]);
  assert.equal(s.state.agents.t1, undefined);
});

test("endAgent with delete kills, removes and deletes the topic", async () => {
  const s = setup();
  await s.feed({ terminals: [term("t1")] });
  await s.sync.endAgent("t1", "delete");
  assert.deepEqual(s.hc.calls.map(c => c[0]), ["kill", "rm"]);
  await s.feed({ method: "event", params: { type: "removed", terminal: "t1", data: {} } });
  assert.equal(s.api.of("deleteForumTopic").length, 1);
  assert.equal(s.api.of("closeForumTopic").length, 0);
  assert.deepEqual(s.state.ended, []);
});

test("sweep closes topics of agents that ended while the bridge was down", async () => {
  const s = setup();
  s.state.agents.t9 = { topic_id: 77, title: "[old] Fix login", icon: "i-working", state: "working" };
  await s.feed({ terminals: [] });
  await s.sync.sweep();
  assert.equal(s.api.of("editForumTopic")[0].params.icon_custom_emoji_id, "i-ended");
  assert.deepEqual(s.state.ended.map(e => e.topic_id), [77]);
});

test("a topic deleted by hand is made again", async () => {
  const s = setup({ reply: "hi" });
  s.state.agents.t1 = { topic_id: 55, title: "[t1] new session", icon: "i-idle", state: "idle" };
  await s.feed({ terminals: [term("t1", "working")] });
  const call = s.api.call;
  let failed = false;
  s.api.call = async (m, p) => {
    if (m === "sendRichMessage" && p.message_thread_id === 55 && !failed) { failed = true; throw new Error("sendMessage: 400 Bad Request: message thread not found"); }
    return call(m, p);
  };
  await s.feed(status("t1", "done"));
  assert.equal(s.api.of("createForumTopic").length, 1);
  assert.equal(s.state.agents.t1.topic_id, 101);
});

test("without an ended icon in Telegram's set, the name carries 🏁", async () => {
  const s = setup({ sync: { icons: {} } });
  await s.feed({ terminals: [term("t1")] });
  await s.feed({ method: "event", params: { type: "finished", terminal: "t1", data: {} } });
  assert.equal(s.api.of("editForumTopic").at(-1).params.name, "🏁 [t1] new session");
});

test("the terminal title names the topic; a new title renames it", async () => {
  const s = setup();
  await s.feed({ terminals: [term("t1", "idle", { title: "✳ Fix the login", labels: { where: "corral / claude" } })] });
  assert.equal(s.api.of("createForumTopic")[0].params.name, "[corral] Fix the login");
  await s.feed({ method: "event", params: { type: "title", terminal: "t1", data: { title: "⠂ Review the diff" } } });
  await tick();
  assert.equal(s.api.of("editForumTopic").at(-1).params.name, "[corral] Review the diff");
});

test("without a title the statusline's session name is used", async () => {
  const s = setup({ sync: { session: async () => ({ session_name: "Bugs 824, 825" }) } });
  await s.feed({ terminals: [term("t1", "idle", { title: "Claude Code" })] });
  assert.equal(s.api.of("createForumTopic")[0].params.name, "[t1] Bugs 824, 825");
});

test("/new: the topic comes at once; a trust question before Claude starts is posted with arrow buttons", async () => {
  const { readFileSync } = await import("node:fs");
  const trust = readFileSync(new URL("./fixtures/screens/trust.txt", import.meta.url), "utf8");
  const s = setup({ screen: trust });
  // A terminal that runs claude but has reported no status yet.
  s.herd.apply({ terminals: [term("t5", "idle", { status: null, labels: { where: "No project / 2" }, cwd: "/Users/me" })] });
  await s.sync.starting(s.herd.live("t5"));
  assert.equal(s.api.of("createForumTopic")[0].params.name.startsWith("[") && s.api.of("createForumTopic")[0].params.name.endsWith("] starting"), true);
  assert.equal(s.api.of("createForumTopic")[0].params.icon_custom_emoji_id, "i-starting");
  await tick();
  const post = s.api.of("sendMessage").at(-1).params;
  const kb = post.reply_markup.inline_keyboard.map(r => r[0]);
  assert.deepEqual(kb.map(b => b.text), ["1 · No, exit", "2 · Yes, I trust this folder"]);
  assert.deepEqual(s.buttons.get(kb[1].callback_data).keys, ["down", "enter"]);
  assert.equal(s.sync.questions.get("t5").pending, true);
});

test("/new: a terminal that ends before Claude starts closes its topic", async () => {
  const s = setup();
  s.herd.apply({ terminals: [term("t5", "idle", { status: null })] });
  await s.sync.starting(s.herd.live("t5"));
  s.herd.apply({ method: "event", params: { type: "removed", terminal: "t5", data: {} } });
  await tick();
  assert.equal(s.api.of("closeForumTopic").length, 1);
  assert.equal(s.state.agents.t5, undefined);
});

// hc get answers with the command line each terminal runs.
const argvs = (s, map) => { s.hc.get = async (t) => ({ foreground: { argv: map[t] ?? ["claude"], pid: 1 } }); };
const finished = (t) => ({ method: "event", params: { type: "finished", terminal: t, data: {} } });

test("resumedSession reads --resume, -r and --resume=", () => {
  assert.equal(resumedSession(["claude", "--resume", "abc"]), "abc");
  assert.equal(resumedSession(["claude", "-r", "abc"]), "abc");
  assert.equal(resumedSession(["claude", "--resume=abc"]), "abc");
  assert.equal(resumedSession(["claude", "--resume", "--model", "x"]), null);
  assert.equal(resumedSession(["claude"]), null);
  assert.equal(resumedSession(undefined), null);
});

test("a session resumed in another terminal opens its ended topic again", async () => {
  const s = setup({ sync: { session: async () => ({ session_id: "S1" }) } });
  argvs(s, { t2: ["claude", "--resume", "S1"] });
  await s.feed({ terminals: [term("t1")] });
  assert.equal(s.state.agents.t1.session_id, "S1");
  await s.feed(finished("t1"));
  assert.deepEqual(s.state.ended.map(e => [e.topic_id, e.session_id]), [[101, "S1"]]);
  await s.feed({ terminals: [term("t2")] });
  await tick();
  assert.equal(s.api.of("createForumTopic").length, 1);
  assert.deepEqual(s.api.of("reopenForumTopic").map(c => c.params.message_thread_id), [101]);
  assert.equal(s.state.agents.t2.topic_id, 101);
  assert.deepEqual(s.state.ended, []);
  assert.match(s.api.of("sendMessage").at(-1).params.text, /^Resumed in/);
  assert.equal(s.api.of("editForumTopic").at(-1).params.icon_custom_emoji_id, "i-idle");
});

test("Restart: the new terminal takes the live topic over, and the old one ending closes nothing", async () => {
  const s = setup({ sync: { session: async () => ({ session_id: "S1" }) } });
  argvs(s, { t2: ["claude", "--resume", "S1"] });
  await s.feed({ terminals: [term("t1")] });
  await s.feed({ terminals: [term("t1"), term("t2")] });
  await tick();
  assert.equal(s.state.agents.t2.topic_id, 101);
  assert.equal(s.state.agents.t1, undefined);
  await s.feed(status("t1", "working"));
  await s.feed({ terminals: [term("t2")] });
  assert.equal(s.api.of("createForumTopic").length, 1);
  assert.equal(s.api.of("closeForumTopic").length, 0);
  assert.deepEqual(s.state.ended, []);
});

test("a resumed session whose topic was deleted gets a new one", async () => {
  const s = setup();
  argvs(s, { t2: ["claude", "--resume", "S1"] });
  s.state.ended.push({ topic_id: 40, title: "[t1] x", ended_at: "", session_id: "S1" });
  const call = s.api.call;
  s.api.call = async (m, p) => {
    if (m === "reopenForumTopic") throw new Error("reopenForumTopic: 400 Bad Request: TOPIC_ID_INVALID");
    return call(m, p);
  };
  await s.feed({ terminals: [term("t2")] });
  assert.equal(s.api.of("createForumTopic").length, 1);
  assert.equal(s.state.agents.t2.topic_id, 101);
  assert.equal(s.state.agents.t2.session_id, "S1");
});

test("the registry holds each made topic until it is deleted", async () => {
  const s = setup();
  await s.feed({ terminals: [term("t1"), term("t2")] });
  assert.deepEqual(s.registry.ids(), [101, 102]);
  await s.sync.endAgent("t1", "delete");
  await s.feed({ method: "event", params: { type: "removed", terminal: "t1", data: {} } });
  assert.deepEqual(s.registry.ids(), [102]);
});
