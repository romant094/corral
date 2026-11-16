import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeSync } from "../agents.mjs";
import { makeCommands, routeText, parseCommand, COMMANDS } from "../commands.mjs";
import { world, term, settings } from "./helpers.mjs";

const tick = () => new Promise(r => setTimeout(r, 5));

async function setup({ terminals = [term("t1")], screen = "" } = {}) {
  const w = world({ terminals: [], screen });
  const sync = makeSync({ ...w, throttleMs: 0, blockedDelayMs: 0, replyRetryMs: 0 });
  const dashboard = { refresh: () => { w.refreshed = (w.refreshed ?? 0) + 1; } };
  const inbox = await mkdtemp(join(tmpdir(), "inbox-"));
  const commands = makeCommands({ ...w, sync, dashboard, inbox, noticeMs: 10 });
  for (const c of w.herd.apply({ terminals })) await sync.handle(c);
  w.api.calls.length = 0;
  const topic = w.state.agents.t1?.topic_id;
  const msg = (text, extra = {}) => ({ message: {
    message_id: 1, chat: { id: settings.chat_id, type: "supergroup" }, from: { id: 7 },
    ...(extra.thread !== null ? { is_topic_message: true, message_thread_id: extra.thread ?? topic } : {}),
    text, ...extra.more,
  } });
  const press = (data, from = 7) => commands.handle({ callback_query: { id: "q", data, from: { id: from }, message: { message_id: 9, chat: { id: settings.chat_id } } } });
  return { ...w, sync, commands, msg, press, topic, inbox };
}

test("routeText: keys only while blocked, refusal for other text then", () => {
  assert.deepEqual(routeText("idle", "fix the bug"), { send: "fix the bug" });
  assert.deepEqual(routeText("idle", "1"), { send: "1" });
  assert.deepEqual(routeText("blocked", " Y "), { keys: ["y"] });
  assert.deepEqual(routeText("blocked", "2"), { keys: ["2"] });
  assert.deepEqual(routeText("blocked", "esc"), { keys: ["esc"] });
  assert.ok(routeText("blocked", "do something else").refuse);
});

test("parseCommand handles @bot and args", () => {
  assert.deepEqual(parseCommand("/new@Corral_bot gmail"), { name: "new", bot: "corral_bot", args: "gmail" });
  assert.deepEqual(parseCommand("/Status"), { name: "status", bot: null, args: "" });
  assert.equal(parseCommand("hello"), null);
});

test("the menu has the six commands", () => {
  assert.deepEqual(COMMANDS.map(c => c.command), ["new", "status", "stop", "close", "clear", "help"]);
});

test("text in an agent topic goes to the agent as one argv element", async () => {
  const s = await setup();
  await s.commands.handle(s.msg("refactor $(rm -rf ~)"));
  assert.deepEqual(s.hc.calls.at(-1), ["send", "t1", "refactor $(rm -rf ~)"]);
});

test("a reply says which message it answers; the topic's first message does not count", async () => {
  const s = await setup();
  const answered = { message_id: 5, from: { id: 99, is_bot: true }, text: "Pick one:\n1. Buttons" };
  await s.commands.handle(s.msg("the first", { more: { reply_to_message: answered } }));
  assert.deepEqual(s.hc.calls.at(-1), ["send", "t1", '[In reply to your earlier message: "Pick one: 1. Buttons"]\nthe first']);
  await s.commands.handle(s.msg("just this", { more: { reply_to_message: { message_id: s.topic, forum_topic_created: { name: "x" } } } }));
  assert.deepEqual(s.hc.calls.at(-1), ["send", "t1", "just this"]);
  await s.commands.handle(s.msg("this part", { more: { reply_to_message: answered, quote: { text: "1. Buttons" } } }));
  assert.deepEqual(s.hc.calls.at(-1), ["send", "t1", '[In reply to your earlier message: "1. Buttons"]\nthis part']);
});

test("messages from other users or chats change nothing", async () => {
  const s = await setup();
  const m = s.msg("hi");
  m.message.from.id = 99;
  await s.commands.handle(m);
  const other = s.msg("hi");
  other.message.chat.id = -5;
  await s.commands.handle(other);
  assert.equal(s.hc.calls.filter(c => c[0] === "send").length, 0);
  assert.equal(s.api.of("sendMessage").length, 0);
  assert.ok(s.logs.some(l => /ignored a message from user 99/.test(l)));
});

test("/stop sends esc; /status in a topic shows that agent only", async () => {
  const s = await setup();
  await s.commands.handle(s.msg("/stop"));
  assert.deepEqual(s.hc.calls.at(-1), ["keys", "t1", "esc"]);
  await s.commands.handle(s.msg("/status"));
  const text = s.api.of("sendMessage").at(-1).params.text;
  assert.match(text, /^<b>\[t1\] new session<\/b>\n☕ idle · /);
  assert.ok(!/Agents \(/.test(text));
});

test("commands in the wrong topic say where they work", async () => {
  const s = await setup();
  await s.commands.handle(s.msg("/new"));
  assert.match(s.api.of("sendMessage").at(-1).params.text, /root topic/);
  await s.commands.handle(s.msg("/stop", { thread: null }));
  assert.match(s.api.of("sendMessage").at(-1).params.text, /agent's topic/);
});

test("/new lists spaces; a press starts Claude there", async () => {
  const s = await setup();
  await s.commands.handle(s.msg("/new", { thread: null }));
  const kb = s.api.of("sendMessage").at(-1).params.reply_markup.inline_keyboard;
  assert.deepEqual(kb.map(r => r[0].text), ["gmail", "notes"]);
  await s.press(kb[0][0].callback_data);
  // Into the tab where gmail's agent works, to its right.
  assert.deepEqual(s.hc.calls.at(-1), ["startClaude", { id: "spA", name: "gmail", folder: "/p/gmail" }, "tbA2"]);
  await s.press(kb[1][0].callback_data);
  // A space without tabs: a tab of its own.
  assert.deepEqual(s.hc.calls.at(-1), ["startClaude", { id: "spB", name: "notes", folder: "/p/notes" }, null]);
  assert.match(s.api.of("createForumTopic").at(-1).params.name, /^\[notes\] starting$/);
  await s.press(kb[1][0].callback_data);
  assert.equal(s.api.of("answerCallbackQuery").at(-1).params.text, "This button has expired.");
});

test("option button sends the digit once; stale press does nothing", async () => {
  const s = await setup({ terminals: [term("t1", "working")], screen: "❯ 1. Yes\n  2. No\n" });
  for (const c of s.herd.apply({ method: "event", params: { type: "status", terminal: "t1", data: { status: { app: "claude-code", state: "blocked" } } } })) await s.sync.handle(c);
  await tick();
  const kb = s.api.of("sendMessage").at(-1).params.reply_markup.inline_keyboard;
  await s.press(kb[1][0].callback_data);
  assert.deepEqual(s.hc.calls.filter(c => c[0] === "keys").at(-1), ["keys", "t1", "2"]);
  assert.equal(s.api.of("editMessageReplyMarkup").at(-1).params.reply_markup.inline_keyboard[0][0].text, "✅ 2 · No");
  await s.press(kb[0][0].callback_data);
  assert.equal(s.api.of("answerCallbackQuery").at(-1).params.text, "This question is no longer open.");
  assert.equal(s.hc.calls.filter(c => c[0] === "keys").length, 1);
});

test("text answers a blocked agent with keys", async () => {
  const s = await setup({ terminals: [term("t1", "blocked")] });
  await s.commands.handle(s.msg("1"));
  assert.deepEqual(s.hc.calls.at(-1), ["keys", "t1", "1"]);
  await s.commands.handle(s.msg("please wait"));
  assert.match(s.api.of("sendMessage").at(-1).params.text, /waiting at a dialog/);
});

test("/close asks; only the latest question acts; cancel keeps the agent", async () => {
  const s = await setup();
  await s.commands.handle(s.msg("/close"));
  const first = s.api.of("sendMessage").at(-1).params.reply_markup.inline_keyboard;
  await s.commands.handle(s.msg("/close"));
  const second = s.api.of("sendMessage").at(-1).params.reply_markup.inline_keyboard;
  await s.press(first[0][0].callback_data);
  assert.equal(s.hc.calls.filter(c => c[0] === "kill").length, 0);
  await s.press(second[2][0].callback_data);
  assert.equal(s.hc.calls.filter(c => c[0] === "kill").length, 0);
  await s.commands.handle(s.msg("/close"));
  const third = s.api.of("sendMessage").at(-1).params.reply_markup.inline_keyboard;
  await s.press(third[1][0].callback_data);
  assert.deepEqual(s.hc.calls.slice(-2).map(c => c[0]), ["kill", "rm"]);
});

test("a button press from another user is refused", async () => {
  const s = await setup();
  await s.commands.handle(s.msg("/close"));
  const kb = s.api.of("sendMessage").at(-1).params.reply_markup.inline_keyboard;
  await s.press(kb[1][0].callback_data, 99);
  assert.equal(s.hc.calls.filter(c => c[0] === "kill").length, 0);
  assert.equal(s.api.of("answerCallbackQuery").at(-1).params.text, "Not allowed.");
});

test("/clear deletes only ended topics, after the confirm press", async () => {
  const s = await setup();
  s.state.ended.push({ topic_id: 40, title: "🏁 a", ended_at: "" }, { topic_id: 41, title: "🏁 b", ended_at: "" });
  await s.commands.handle(s.msg("/clear", { thread: null }));
  const kb = s.api.of("sendMessage").at(-1).params.reply_markup.inline_keyboard;
  assert.match(s.api.of("sendMessage").at(-1).params.text, /Delete 2 topics/);
  assert.equal(s.api.of("deleteForumTopic").length, 0);
  await s.press(kb[0][0].callback_data);
  assert.deepEqual(s.api.of("deleteForumTopic").map(c => c.params.message_thread_id), [40, 41]);
  assert.deepEqual(s.state.ended, []);
  assert.ok(!s.api.of("deleteForumTopic").some(c => c.params.message_thread_id === s.topic));
});

test("Delete topic button deletes an ended topic only", async () => {
  const s = await setup();
  s.state.ended.push({ topic_id: 40, title: "🏁 a", ended_at: "" });
  const id = s.buttons.register({ type: "deltopic", topic_id: 40 });
  await s.press(id);
  assert.equal(s.api.of("deleteForumTopic").length, 1);
  await s.press(id);
  assert.equal(s.api.of("answerCallbackQuery").at(-1).params.text, "Nothing to delete.");
});

test("a photo goes to the agent with its caption", async () => {
  const s = await setup();
  await s.commands.handle(s.msg(undefined, { more: { caption: "look at this", photo: [{ file_id: "a", file_size: 10 }, { file_id: "b", file_size: 20 }] } }));
  const put = s.hc.calls.find(c => c[0] === "put");
  assert.ok(put[2].startsWith(join(s.inbox, "t1")));
  assert.match(put[2], /-photo\.jpg$/);
  assert.deepEqual(s.hc.calls.at(-1), ["send", "t1", "look at this /core/files/t1/x"]);
});

test("a file over 20 MB is refused", async () => {
  const s = await setup();
  await s.commands.handle(s.msg(undefined, { more: { document: { file_id: "a", file_name: "big.zip", file_size: 21 * 1024 * 1024 } } }));
  assert.match(s.api.of("sendMessage").at(-1).params.text, /20 MB/);
  assert.equal(s.hc.calls.filter(c => c[0] === "put").length, 0);
});

test("groups and topics the bot sees are remembered for the wizard", async () => {
  const s = await setup();
  await s.commands.handle({ my_chat_member: { chat: { id: -2002, type: "supergroup", title: "Other", is_forum: true } } });
  await s.commands.handle({ message: { message_id: 3, chat: { id: -2002, type: "supergroup", title: "Other", is_forum: true }, from: { id: 99 },
    is_topic_message: true, message_thread_id: 12, forum_topic_created: { name: "Corral" } } });
  assert.ok(s.state.chats.some(c => c.id === -2002 && c.forum));
  assert.deepEqual(s.state.topics[-2002], [{ id: 12, name: "Corral" }]);
});

test("messages in a closed topic are removed, with a notice that goes too", async () => {
  const s = await setup();
  s.state.ended.push({ topic_id: 40, title: "", ended_at: "" });
  await s.commands.handle(s.msg("still there?", { thread: 40 }));
  assert.deepEqual(s.api.of("deleteMessage").map(c => c.params.message_id), [1]);
  assert.match(s.api.of("sendMessage").at(-1).params.text, /Agent has ended/);
  await new Promise(r => setTimeout(r, 30));
  assert.equal(s.api.of("deleteMessage").length, 2);
  assert.equal(s.hc.calls.length, 0);
});
