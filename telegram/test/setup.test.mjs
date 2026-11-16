import { test } from "node:test";
import assert from "node:assert/strict";
import { emptyState, rememberMessage } from "../config.mjs";
import { TelegramError } from "../telegram.mjs";
import { check, discover, createTopic, listing, restoreGeneral } from "../setup.mjs";
import { fakeApi, settings } from "./helpers.mjs";

const hc = { ls: async () => ({ terminals: [{ agent: "claude-code" }, { agent: null }] }) };

function api(answers) {
  const base = fakeApi();
  const call = async (method, params) => {
    base.calls.push({ method, params });
    const a = answers[method];
    if (a instanceof Error) throw a;
    return typeof a === "function" ? a(params) : a;
  };
  return { ...base, call, raw: call };
}

test("check: a token alone reports the bot and hc, no group", async () => {
  const out = await check({ api: api({ getMe: { id: 9, username: "corral_bot", can_join_groups: true } }), hc, settings: { token: "1:x", chat_id: null } });
  assert.deepEqual(out, { ok: true, bot: { id: 9, username: "corral_bot", groups: true, privacy: true }, group: null, rights: null, hc: { agents: 1 }, errors: [] });
});

test("check: missing rights and Topics off fail with the reason", async () => {
  const out = await check({ hc, settings, api: api({
    getMe: { id: 9, username: "b" },
    getChat: { id: -1001, title: "Herd", is_forum: false },
    getChatMember: { status: "administrator", can_manage_topics: true, can_delete_messages: false, can_pin_messages: true },
  }) });
  assert.equal(out.ok, false);
  assert.deepEqual(out.group, { id: -1001, title: "Herd", forum: false });
  assert.deepEqual(out.rights, { admin: true, missing: ["can_delete_messages"] });
  assert.deepEqual(out.errors, ["group: Topics are off"]);
});

test("check: a rejected token says so and never shows it", async () => {
  const out = await check({ hc, settings: { token: "1:x", chat_id: null }, api: api({ getMe: new TelegramError("getMe", 401, "Unauthorized") }) });
  assert.equal(out.ok, false);
  assert.deepEqual(out.errors, ["bot: the token was rejected"]);
});

test("discover: reads without confirming and learns groups, topics and people", async () => {
  const state = emptyState();
  state.offset = 40;
  const a = api({ getUpdates: [
    { update_id: 40, my_chat_member: { chat: { id: -1002, type: "supergroup", title: "Other", is_forum: false } } },
    { update_id: 41, message: { chat: { id: -1001, type: "supergroup", title: "Herd", is_forum: true }, from: { id: 7, first_name: "Anton", username: "anton" },
      is_topic_message: true, message_thread_id: 3, forum_topic_created: { name: "Corral" } } },
    { update_id: 42, message: { chat: { id: -1001, type: "supergroup", title: "Herd", is_forum: true }, from: { id: 8, first_name: "Bot", is_bot: true },
      is_topic_message: true, message_thread_id: 5 } },
    { update_id: 43, message: { chat: { id: 7, type: "private" }, from: { id: 7, first_name: "Anton" } } },
  ] });
  const { changed, found } = await discover({ api: a, state });
  assert.equal(changed, true);
  assert.equal(a.calls[0].params.offset, 40);
  assert.equal(state.offset, 40);
  assert.deepEqual(found.chats.map(c => c.id), [-1002, -1001]);
  assert.deepEqual(found.topics[-1001], [{ id: 3, name: "Corral" }, { id: 5, name: "#5" }]);
  assert.deepEqual(found.people, [{ id: 7, name: "Anton", username: "anton", chat_id: -1001 }]);
});

test("a rename of General is remembered by group", () => {
  const state = emptyState();
  rememberMessage(state, { chat: { id: -1001, type: "supergroup", title: "Herd", is_forum: true }, from: { id: 7, first_name: "A" },
    forum_topic_edited: { name: "Session Manager" } });
  assert.deepEqual(state.general_names, { "-1001": "Session Manager" });
});

test("listing leaves out the agents' own topics", () => {
  const state = emptyState();
  state.topics[-1001] = [{ id: 3, name: "Corral" }, { id: 5, name: "[x] a" }, { id: 6, name: "[x] b" }];
  state.agents.t1 = { topic_id: 5 };
  state.ended.push({ topic_id: 6 });
  assert.deepEqual(listing(state).topics[-1001], [{ id: 3, name: "Corral" }]);
});

test("restoreGeneral shows and opens General, takes 'not modified' as done, and posts a line there", async () => {
  const a = api({
    unhideGeneralForumTopic: new TelegramError("unhideGeneralForumTopic", 400, "Bad Request: TOPIC_NOT_MODIFIED"),
    reopenGeneralForumTopic: true,
    sendMessage: { message_id: 1 },
  });
  assert.deepEqual(await restoreGeneral({ api: a, settings }), { done: ["reopened"] });
  assert.equal(a.of("sendMessage")[0].params.message_thread_id, undefined);
  const bad = api({ unhideGeneralForumTopic: new TelegramError("unhideGeneralForumTopic", 400, "Bad Request: not enough rights") });
  await assert.rejects(restoreGeneral({ api: bad, settings }), /rights/);
});

test("createTopic makes the topic in the set group and remembers it", async () => {
  const state = emptyState();
  const a = api({ createForumTopic: (p) => ({ message_thread_id: 77, name: p.name }) });
  assert.deepEqual(await createTopic({ api: a, settings, state, name: "Corral" }), { id: 77, name: "Corral" });
  assert.deepEqual(state.topics[-1001], [{ id: 77, name: "Corral" }]);
  await assert.rejects(createTopic({ api: a, settings: { chat_id: null }, state, name: "x" }), /group first/);
});
