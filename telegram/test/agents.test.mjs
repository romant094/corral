import { test } from "node:test";
import assert from "node:assert/strict";
import { makeSync, topicName, pickIcons } from "../agents.mjs";
import { world, term, status } from "./helpers.mjs";

const tick = () => new Promise(r => setTimeout(r, 5));

function setup(opts) {
  const w = world(opts);
  const icons = Object.fromEntries(["starting", "working", "blocked", "done", "idle", "ended"].map(k => [k, `i-${k}`]));
  const sync = makeSync({ ...w, icons, throttleMs: 0, blockedDelayMs: 0, replyRetryMs: 0, startCheckMs: 1, ...opts?.sync });
  const feed = async (msg) => { for (const c of w.herd.apply(msg)) await sync.handle(c); await tick(); };
  return { ...w, sync, feed };
}

test("done waits for a reply that is new, not the previous turn's", async () => {
  const replies = ["Old answer.", "Old answer.", "New answer."];
  const s = setup({ sync: { lastReply: async () => replies.shift() ?? "New answer." } });
  await s.feed({ terminals: [term("t1", "working")] });
  // The first turn posts "Old answer."; the second sees it twice before the new one lands.
  await s.feed(status("t1", "done"));
  await s.feed(status("t1", "working"));
  await s.feed(status("t1", "done"));
  const texts = s.api.of("sendMessage").map(c => c.params.text).filter(t => /answer/.test(t));
  assert.deepEqual(texts, ["Old answer.", "New answer."]);
});

test("topic name is [project] title, cut to 128", () => {
  assert.equal(topicName("corral", "Telegram bridge"), "[corral] Telegram bridge");
  assert.equal(topicName("corral", ""), "[corral] new session");
  assert.equal(topicName("x", "y".repeat(300)).length, 128);
});

test("icons: each status takes the first emoji Telegram's set has", () => {
  const icons = pickIcons([{ emoji: "⚡️", custom_emoji_id: "w" }, { emoji: "😴", custom_emoji_id: "z" }, { emoji: "✅", custom_emoji_id: "d" }]);
  assert.equal(icons.working, "w");
  assert.equal(icons.idle, "z");
  assert.equal(icons.done, "d");
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
  const texts = s.api.of("sendMessage").map(c => c.params.text);
  assert.ok(texts.includes("All tests pass."));
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
  assert.deepEqual(s.api.of("editForumTopic").at(-1).params, { chat_id: -1001, message_thread_id: 101, name: "[t1] new session", icon_custom_emoji_id: "i-ended" });
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
    if (m === "sendMessage" && p.message_thread_id === 55 && !failed) { failed = true; throw new Error("sendMessage: 400 Bad Request: message thread not found"); }
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
