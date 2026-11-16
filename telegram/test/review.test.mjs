// Cases from the code and security review: recovery paths, restarts, failures.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeSync } from "../agents.mjs";
import { makeCommands } from "../commands.mjs";
import { makeDashboard } from "../dashboard.mjs";
import { makeHerd } from "../herdr.mjs";
import { emptyState, rememberChat, MAX_CHATS } from "../config.mjs";
import { world, term, status, settings } from "./helpers.mjs";

const tick = () => new Promise(r => setTimeout(r, 5));

async function setup({ terminals = [term("t1")], screen = "" } = {}) {
  const w = world({ terminals: [], screen });
  const sync = makeSync({ ...w, throttleMs: 0, blockedDelayMs: 0, replyRetryMs: 0 });
  const inbox = await mkdtemp(join(tmpdir(), "inbox-"));
  const commands = makeCommands({ ...w, sync, dashboard: { refresh() {} }, inbox, bot: "corral_bot", nowSec: () => 1000 });
  const feed = async (msg) => { for (const c of w.herd.apply(msg)) await sync.handle(c); await tick(); };
  await feed({ terminals });
  w.api.calls.length = 0;
  const topic = w.state.agents.t1?.topic_id;
  const msg = (text, more = {}) => ({ message: {
    message_id: 1, date: 1000, chat: { id: settings.chat_id, type: "supergroup" }, from: { id: 7 },
    is_topic_message: true, message_thread_id: topic, text, ...more,
  } });
  const press = (data) => commands.handle({ callback_query: { id: "q", data, from: { id: 7 }, message: { message_id: 9, chat: { id: settings.chat_id } } } });
  return { ...w, sync, commands, feed, msg, press, topic };
}

const failing = (api, match, error) => {
  const call = api.call;
  api.call = async (m, p) => { if (match(m, p)) throw new Error(error); return call(m, p); };
};

test("a deleted topic is not made again for an agent that has ended", async () => {
  const s = await setup();
  failing(s.api, (m) => m === "editForumTopic", "editForumTopic: 400 Bad Request: message thread not found");
  // The agent ends (topic deleted by /close) while a rename is in flight.
  s.sync.ending.set("t1", "delete");
  await s.feed({ method: "event", params: { type: "finished", terminal: "t1", data: {} } });
  await s.feed(status("t1", "working"));
  assert.equal(s.api.of("createForumTopic").length, 0);
});

test("a topic closed by hand is reopened, not replaced", async () => {
  const s = await setup({ terminals: [term("t1", "done")] });
  let once = false;
  failing(s.api, (m, p) => m === "sendMessage" && p.message_thread_id === s.topic && !once && (once = true), "sendMessage: 400 Bad Request: TOPIC_CLOSED");
  await s.sync.handle({ kind: "state", agent: { ...s.herd.get("t1"), state: "done" } });
  assert.equal(s.api.of("reopenForumTopic").length, 1);
  assert.equal(s.api.of("createForumTopic").length, 0);
});

test("an agent already blocked when first seen gets its question", async () => {
  const s = await setup({ terminals: [term("t1", "blocked")], screen: "❯ 1. Yes\n  2. No\n" });
  await tick();
  // The question was posted during the first snapshot.
  assert.ok(s.sync.questions.get("t1"));
});

test("a mapped agent with a null status at restart is not swept", () => {
  const known = new Set(["t1"]);
  const herd = makeHerd(() => 0, (a) => known.has(a));
  const changes = herd.apply({ terminals: [term("t1", "idle", { status: null })] });
  assert.deepEqual(changes.map(c => c.kind), ["added"]);
  assert.ok(herd.get("t1"));
  const fresh = makeHerd(() => 0);
  assert.deepEqual(fresh.apply({ terminals: [term("t1", "idle", { status: null })] }), []);
});

test("a failed /close disarms the delete and says so", async () => {
  const s = await setup();
  s.hc.kill = async () => { throw new Error("hc timed out"); };
  await s.commands.handle(s.msg("/close"));
  const kb = s.api.of("sendMessage").at(-1).params.reply_markup.inline_keyboard;
  await s.press(kb[1][0].callback_data);
  assert.equal(s.sync.ending.has("t1"), false);
  assert.match(s.api.of("editMessageText").at(-1).params.text, /Could not end the agent: hc timed out/);
});

test("a prompt hc refuses is reported in the topic", async () => {
  const s = await setup();
  s.hc.send = async () => { throw new Error("no terminal t1"); };
  await s.commands.handle(s.msg("fix it"));
  assert.match(s.api.of("sendMessage").at(-1).params.text, /Not delivered: no terminal t1/);
});

test("text sent while the bridge was offline is not typed", async () => {
  const s = await setup();
  await s.commands.handle(s.msg("1", { date: 1000 - 600 }));
  assert.equal(s.hc.calls.filter(c => c[0] === "send" || c[0] === "keys").length, 0);
  assert.match(s.api.of("sendMessage").at(-1).params.text, /offline/);
});

test("an option button does not answer a different dialog", async () => {
  const s = await setup({ terminals: [term("t1", "working")], screen: "❯ 1. Yes\n  2. No\n" });
  await s.feed(status("t1", "blocked"));
  await tick();
  const kb = s.api.of("sendMessage").at(-1).params.reply_markup.inline_keyboard;
  s.hc.screen = "❯ 1. Allow edit\n  2. Deny\n";
  s.hc.read = async () => s.hc.screen;
  await s.press(kb[0][0].callback_data);
  assert.equal(s.hc.calls.filter(c => c[0] === "keys").length, 0);
  assert.match(s.api.of("answerCallbackQuery").at(-1).params.text, /dialog has changed/);
});

test("commands for another bot are ignored; Claude's own commands reach the agent", async () => {
  const s = await setup();
  await s.commands.handle(s.msg("/stop@other_bot"));
  assert.equal(s.hc.calls.length, 0);
  await s.commands.handle(s.msg("/compact keep the plan"));
  assert.deepEqual(s.hc.calls.at(-1), ["send", "t1", "/compact keep the plan"]);
  await s.commands.handle(s.msg("/stop@corral_bot"));
  assert.deepEqual(s.hc.calls.at(-1), ["keys", "t1", "esc"]);
});

test("Clear all deletes only the topics its question counted", async () => {
  const s = await setup();
  s.state.ended.push({ topic_id: 40, title: "", ended_at: "" });
  await s.commands.handle(s.msg("/clear", { is_topic_message: false, message_thread_id: undefined }));
  const kb = s.api.of("sendMessage").at(-1).params.reply_markup.inline_keyboard;
  s.state.ended.push({ topic_id: 41, title: "", ended_at: "" });
  await s.press(kb[0][0].callback_data);
  assert.deepEqual(s.api.of("deleteForumTopic").map(c => c.params.message_thread_id), [40]);
  assert.deepEqual(s.state.ended.map(e => e.topic_id), [41]);
});

test("the dashboard's Clear all button never expires", async () => {
  const s = await setup();
  s.state.ended.push({ topic_id: 40, title: "", ended_at: "" });
  await s.press("clearask");
  assert.match(s.api.of("sendMessage").at(-1).params.text, /Delete 1 topic/);
});

test("dashboard: posted and pinned once, edited after, re-posted when gone", async () => {
  const w = world({ terminals: [term("t1")] });
  const d = makeDashboard({ ...w, throttleMs: 0, now: () => 0 });
  await d.draw();
  assert.equal(w.api.of("sendMessage").length, 1);
  assert.equal(w.api.of("pinChatMessage").length, 1);
  w.herd.apply(status("t1", "working"));
  await d.draw();
  assert.equal(w.api.of("editMessageText").length, 1);
  failing(w.api, (m) => m === "editMessageText", "editMessageText: 400 Bad Request: MESSAGE_ID_INVALID");
  w.herd.apply(status("t1", "done"));
  await d.draw();
  assert.equal(w.api.of("sendMessage").length, 2);
});

test("dashboard: a dashboard left in an old root topic is unpinned and posted again in the root", async () => {
  const w = world({ terminals: [term("t1")] });
  w.state.dashboard_message_id = 40;
  w.state.dashboard_where = "-1001/229";
  const d = makeDashboard({ ...w, throttleMs: 0, now: () => 0 });
  await d.draw();
  assert.equal(w.api.of("unpinChatMessage")[0].params.message_id, 40);
  assert.equal(w.api.of("editMessageText").length, 0);
  assert.equal(w.api.of("sendMessage")[0].params.message_thread_id, undefined);
  assert.equal(w.state.dashboard_where, "-1001/general");
});

test("dashboard: a slow first post is not doubled by the next refresh", async () => {
  const w = world({ terminals: [term("t1")] });
  const call = w.api.call;
  w.api.call = async (m, p) => { if (m === "sendMessage") await new Promise(r => setTimeout(r, 30)); return call(m, p); };
  const d = makeDashboard({ ...w, throttleMs: 0, now: () => 0 });
  d.refresh();
  await tick();
  w.herd.apply(status("t1", "working"));
  d.refresh();
  await new Promise(r => setTimeout(r, 80));
  assert.equal(w.api.of("sendMessage").length, 1);
});

test("groups the bot is added to are capped", () => {
  const s = emptyState();
  for (let i = 0; i < MAX_CHATS + 5; i++) rememberChat(s, { id: -1000 - i, type: "supergroup", title: `g${i}` });
  assert.equal(s.chats.length, MAX_CHATS);
  // The newest stays in: the oldest made room.
  assert.equal(s.chats.at(-1).id, -1000 - (MAX_CHATS + 4));
  assert.equal(s.chats[0].id, -1005);
});
