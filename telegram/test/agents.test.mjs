import { test } from "node:test";
import assert from "node:assert/strict";
import { makeSync, topicName } from "../agents.mjs";
import { world, term, status } from "./helpers.mjs";

const tick = () => new Promise(r => setTimeout(r, 5));

function setup(opts) {
  const w = world(opts);
  const sync = makeSync({ ...w, throttleMs: 0, blockedDelayMs: 0 });
  const feed = async (msg) => { for (const c of w.herd.apply(msg)) await sync.handle(c); await tick(); };
  return { ...w, sync, feed };
}

test("topic name carries the status emoji and is cut to 128", () => {
  assert.equal(topicName("working", "gmail / 1"), "⚡ gmail / 1");
  assert.equal(topicName("weird", "x"), "💤 x");
  assert.equal(topicName("done", "y".repeat(300)).length, 128);
});

test("a new agent gets one topic and a start line", async () => {
  const s = setup();
  await s.feed({ terminals: [term("t1")] });
  assert.equal(s.api.of("createForumTopic").length, 1);
  assert.equal(s.api.of("createForumTopic")[0].params.name, "💤 t1 / 1");
  assert.match(s.api.of("sendMessage")[0].params.text, /Started in <code>\/p\/t1<\/code>/);
  assert.equal(s.state.agents.t1.topic_id, 101);
});

test("a known agent reuses its topic after a restart", async () => {
  const s = setup();
  s.state.agents.t1 = { topic_id: 55, title: "💤 t1 / 1", state: "idle" };
  await s.feed({ terminals: [term("t1")] });
  assert.equal(s.api.of("createForumTopic").length, 0);
});

test("status change renames; done posts the last reply", async () => {
  const s = setup({ reply: "All tests pass." });
  await s.feed({ terminals: [term("t1")] });
  await s.feed(status("t1", "working"));
  await s.feed(status("t1", "done"));
  await tick();
  const names = s.api.of("editForumTopic").map(c => c.params.name);
  assert.ok(names.includes("✅ t1 / 1") || names.includes("⚡ t1 / 1"));
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
  assert.equal(s.api.of("editForumTopic").at(-1).params.name, "🏁 t1 / 1");
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
  s.state.agents.t9 = { topic_id: 77, title: "⚡ old / 1", state: "working" };
  await s.feed({ terminals: [] });
  await s.sync.sweep();
  assert.equal(s.api.of("editForumTopic")[0].params.name, "🏁 old / 1");
  assert.deepEqual(s.state.ended.map(e => e.topic_id), [77]);
});

test("a topic deleted by hand is made again", async () => {
  const s = setup({ reply: "hi" });
  s.state.agents.t1 = { topic_id: 55, title: "💤 t1 / 1", state: "idle" };
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
