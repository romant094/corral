// Settings (telegram.json, written by the Corral mod or by hand) and state
// (telegram-state.json, written only by the bridge). Both live in
// $HERDR_APP_HOME/corral, so the whole setup moves with that one folder.
import { readFile, writeFile, rename, mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join, dirname } from "node:path";

export function paths(env = process.env) {
  const home = env.HERDR_APP_HOME || join(env.HOME || homedir(), ".config", "herdr-app");
  const dir = join(home, "corral");
  return {
    dir,
    settings: join(dir, "telegram.json"),
    state: join(dir, "telegram-state.json"),
    lock: join(dir, "telegram.lock"),
    inbox: join(dir, "inbox"),
    log: join(dir, "telegram.log"),
  };
}

export class ConfigError extends Error {
  constructor(field, problem) {
    super(`telegram.json: ${field} ${problem}`);
    this.field = field;
  }
}

// The wizard in Corral saves the token first and the group and owners later.
// The daemon does not run on such a file; it says what is left to do.
export class IncompleteError extends ConfigError {
  constructor(missing) {
    super("(setup)", "");
    this.message = "Finish the Telegram settings in Corral";
    this.missing = missing;
  }
}

// Every field is checked here, so the rest of the bridge can trust the object.
// `partial`: only the token is needed (the wizard's checks); fields that are set must still be valid.
export function validateSettings(raw, { partial = false } = {}) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new ConfigError("(root)", "must be an object");
  const { token, chat_id = null, root_topic_id = null, owner_ids = null } = raw;
  if (typeof token !== "string" || !/^\d+:[A-Za-z0-9_-]{20,}$/.test(token)) {
    throw new ConfigError("token", "must be a bot token from @BotFather (123456:ABC…)");
  }
  if (chat_id !== null && (!Number.isSafeInteger(chat_id) || chat_id >= 0)) {
    throw new ConfigError("chat_id", "must be the group's negative id (-100…)");
  }
  if (root_topic_id !== null && !(Number.isSafeInteger(root_topic_id) && root_topic_id > 0)) {
    throw new ConfigError("root_topic_id", "must be null (General) or a topic id");
  }
  if (owner_ids !== null && (!Array.isArray(owner_ids) || owner_ids.length === 0 || !owner_ids.every(id => Number.isSafeInteger(id) && id > 0))) {
    throw new ConfigError("owner_ids", "must list at least one Telegram user id");
  }
  // fold_chars: replies longer than this fold into sections; 0 never folds. Set in Corral's settings.
  const { fold_chars = 1200 } = raw;
  if (!(Number.isSafeInteger(fold_chars) && fold_chars >= 0 && fold_chars <= 30000)) {
    throw new ConfigError("fold_chars", "must be a whole number from 0 (never fold) to 30000");
  }
  // reply_format: "rich" (a rich message, folded by fold_chars) or "markdown" (Claude's Markdown as plain text).
  const { reply_format = "rich" } = raw;
  if (reply_format !== "rich" && reply_format !== "markdown") throw new ConfigError("reply_format", 'must be "rich" or "markdown"');
  const missing = [chat_id === null && "chat_id", owner_ids === null && "owner_ids"].filter(Boolean);
  if (missing.length && !partial) throw new IncompleteError(missing);
  return { token, chat_id, root_topic_id, owner_ids, fold_chars, reply_format };
}

export async function loadSettings(file, options) {
  let text;
  try {
    text = await readFile(file, "utf8");
  } catch {
    throw new ConfigError("(file)", `not found at ${file}`);
  }
  let raw;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new ConfigError("(file)", "is not valid JSON");
  }
  return validateSettings(raw, options);
}

// launchd appends the bridge's output to one file; each start keeps only its last `max` bytes.
export const LOG_MAX = 1024 * 1024;
export async function trimLog(file, max = LOG_MAX) {
  let text;
  try { text = await readFile(file); } catch { return false; }
  if (text.length <= max) return false;
  const tail = text.subarray(text.length - max);
  // Start at a whole line.
  const nl = tail.indexOf(10);
  await writeFile(file, nl >= 0 ? tail.subarray(nl + 1) : tail);
  return true;
}

export const emptyState = () => ({
  daemon: { pid: null, started_at: null, heartbeat_at: null, status: "stopped", error: null, bot: null },
  offset: 0,
  chats: [],
  topics: {},
  people: [],
  agents: {},
  ended: [],
  dashboard_message_id: null,
});

// A missing or broken state file starts fresh: the bridge rebuilds it from hc and Telegram.
export async function loadState(file) {
  try {
    const saved = JSON.parse(await readFile(file, "utf8"));
    const base = emptyState();
    return { ...base, ...saved, daemon: { ...base.daemon, ...saved.daemon } };
  } catch {
    return emptyState();
  }
}

// Temp file and rename: the mod never reads half a file.
export async function saveState(file, state) {
  await mkdir(dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  await writeFile(tmp, JSON.stringify(state, null, 2));
  await rename(tmp, file);
}

// Groups and topics the bot has seen. The Bot API cannot list them, so the
// wizard reads these. Anyone can add the bot to a group, so the lists are capped.
export const MAX_CHATS = 20;
export const MAX_TOPICS = 200;

export function rememberChat(state, chat) {
  if (!chat || chat.type === "private") return false;
  const entry = { id: chat.id, title: chat.title ?? String(chat.id), forum: !!chat.is_forum };
  const i = state.chats.findIndex(c => c.id === chat.id);
  if (i >= 0 && state.chats[i].title === entry.title && state.chats[i].forum === entry.forum) return false;
  if (i >= 0) state.chats[i] = entry;
  else {
    // Full: the oldest goes, so groups made to fill the list cannot keep a real one out for good.
    if (state.chats.length >= MAX_CHATS) state.chats.shift();
    state.chats.push(entry);
  }
  return true;
}

// What one group message tells the wizard: the group, its topic, who wrote. True when state changed.
export function rememberMessage(state, msg) {
  // Turning Topics on makes a group a supergroup with a new id; the old id is dead from then on.
  const dead = msg.migrate_to_chat_id ? msg.chat?.id : msg.migrate_from_chat_id;
  if (dead && state.chats.some(c => c.id === dead)) {
    state.chats = state.chats.filter(c => c.id !== dead);
    if (msg.migrate_to_chat_id) return true;
  }
  let changed = rememberChat(state, msg.chat) || !!dead;
  if (msg.chat?.type === "private") return changed;
  const thread = msg.is_topic_message ? msg.message_thread_id : null;
  const created = msg.forum_topic_created ?? msg.reply_to_message?.forum_topic_created;
  if (thread && created) changed = rememberTopic(state, msg.chat.id, thread, created.name) || changed;
  if (thread && msg.forum_topic_edited?.name) changed = rememberTopic(state, msg.chat.id, thread, msg.forum_topic_edited.name) || changed;
  // General has no thread id: a rename there is the group's first topic getting a new name.
  if (!thread && msg.forum_topic_edited?.name && msg.chat?.is_forum) {
    const names = (state.general_names ??= {});
    if (names[msg.chat.id] !== msg.forum_topic_edited.name) { names[msg.chat.id] = msg.forum_topic_edited.name; changed = true; }
  }
  if (msg.chat) changed = rememberPerson(state, msg.from, msg.chat.id) || changed;
  return changed;
}

// People who wrote in a known group: the wizard's owner step lists them, newest first.
export const MAX_PEOPLE = 50;
export function rememberPerson(state, from, chatId) {
  if (!from || from.is_bot) return false;
  const people = (state.people ??= []);
  const name = [from.first_name, from.last_name].filter(Boolean).join(" ") || from.username || String(from.id);
  const entry = { id: from.id, name, username: from.username ?? null, chat_id: chatId };
  const i = people.findIndex(p => p.id === from.id && p.chat_id === chatId);
  if (i === 0 && JSON.stringify(people[0]) === JSON.stringify(entry)) return false;
  if (i >= 0) people.splice(i, 1);
  people.unshift(entry);
  people.length = Math.min(people.length, MAX_PEOPLE);
  return true;
}

export function rememberTopic(state, chatId, id, name) {
  const list = (state.topics[chatId] ??= []);
  const known = list.find(t => t.id === id);
  if (known) {
    if (!name || known.name === name) return false;
    known.name = name;
    return true;
  }
  if (list.length >= MAX_TOPICS) return false;
  list.push({ id, name: name ?? `#${id}` });
  return true;
}
