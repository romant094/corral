import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  paths, validateSettings, loadSettings, loadState, saveState, emptyState, ConfigError, IncompleteError,
  rememberChat, rememberTopic, trimLog,
} from "../config.mjs";

const good = { token: "123456:ABCDEFGHIJKLMNOPQRSTUVWXYZ_-abc", chat_id: -1001234567890, root_topic_id: null, owner_ids: [42] };

test("paths follow HERDR_APP_HOME", () => {
  const p = paths({ HERDR_APP_HOME: "/x", HOME: "/h" });
  assert.equal(p.settings, "/x/corral/telegram.json");
  assert.equal(p.state, "/x/corral/telegram-state.json");
  assert.equal(paths({ HOME: "/h" }).dir, "/h/.config/herdr-app/corral");
});

test("valid settings pass and root_topic_id defaults to null", () => {
  const { root_topic_id, ...rest } = good;
  assert.deepEqual(validateSettings(rest), { ...good, fold_chars: 1200, reply_format: "rich" });
});

for (const [field, value] of [
  ["token", "nope"],
  ["chat_id", 123],
  ["chat_id", "-100"],
  ["root_topic_id", 0],
  ["owner_ids", []],
  ["owner_ids", ["42"]],
]) {
  test(`bad ${field} names the field`, () => {
    assert.throws(() => validateSettings({ ...good, [field]: value }), (err) => err instanceof ConfigError && err.field === field);
  });
}

test("missing settings file is a ConfigError", async () => {
  await assert.rejects(loadSettings("/nonexistent/telegram.json"), ConfigError);
});

test("state round-trips and a broken file starts fresh", async () => {
  const dir = await mkdtemp(join(tmpdir(), "tg-"));
  const file = join(dir, "sub", "state.json");
  assert.deepEqual(await loadState(file), emptyState());
  const s = emptyState();
  s.offset = 7;
  s.agents.t1 = { topic_id: 3, title: "x", state: "idle" };
  await saveState(file, s);
  assert.deepEqual(await loadState(file), s);
  await writeFile(file, "{broken");
  assert.deepEqual(await loadState(file), emptyState());
});

test("rememberChat skips private chats and updates titles", () => {
  const s = emptyState();
  assert.equal(rememberChat(s, { id: 1, type: "private" }), false);
  assert.equal(rememberChat(s, { id: -5, type: "supergroup", title: "A", is_forum: true }), true);
  assert.equal(rememberChat(s, { id: -5, type: "supergroup", title: "A", is_forum: true }), false);
  assert.equal(rememberChat(s, { id: -5, type: "supergroup", title: "B", is_forum: true }), true);
  assert.deepEqual(s.chats, [{ id: -5, title: "B", forum: true }]);
});

test("a token alone is a draft: fine for the wizard, unfinished for the daemon", () => {
  const draft = { token: good.token };
  assert.deepEqual(validateSettings(draft, { partial: true }), { token: good.token, chat_id: null, root_topic_id: null, owner_ids: null, fold_chars: 1200, reply_format: "rich" });
  assert.throws(() => validateSettings(draft), (err) => err instanceof IncompleteError
    && err.message === "Finish the Telegram settings in Corral" && err.missing.join() === "chat_id,owner_ids");
  assert.throws(() => validateSettings({ ...draft, chat_id: 5 }, { partial: true }), (err) => err.field === "chat_id");
});

test("trimLog keeps the last whole lines under the limit", async () => {
  const dir = await mkdtemp(join(tmpdir(), "tg-"));
  const file = join(dir, "telegram.log");
  assert.equal(await trimLog(file, 10), false);
  await writeFile(file, "aaaa\nbbbb\ncccc\n");
  assert.equal(await trimLog(file, 100), false);
  assert.equal(await trimLog(file, 8), true);
  assert.equal(await readFile(file, "utf8"), "cccc\n");
});

test("rememberTopic adds and renames", () => {
  const s = emptyState();
  assert.equal(rememberTopic(s, -5, 9, "Corral"), true);
  assert.equal(rememberTopic(s, -5, 9, undefined), false);
  assert.equal(rememberTopic(s, -5, 9, "Root"), true);
  assert.deepEqual(s.topics[-5], [{ id: 9, name: "Root" }]);
});
