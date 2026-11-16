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
  };
}

export class ConfigError extends Error {
  constructor(field, problem) {
    super(`telegram.json: ${field} ${problem}`);
    this.field = field;
  }
}

// Every field is checked here, so the rest of the bridge can trust the object.
export function validateSettings(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new ConfigError("(root)", "must be an object");
  const { token, chat_id, root_topic_id = null, owner_ids } = raw;
  if (typeof token !== "string" || !/^\d+:[A-Za-z0-9_-]{20,}$/.test(token)) {
    throw new ConfigError("token", "must be a bot token from @BotFather (123456:ABC…)");
  }
  if (!Number.isSafeInteger(chat_id) || chat_id >= 0) {
    throw new ConfigError("chat_id", "must be the group's negative id (-100…)");
  }
  if (root_topic_id !== null && !(Number.isSafeInteger(root_topic_id) && root_topic_id > 0)) {
    throw new ConfigError("root_topic_id", "must be null (General) or a topic id");
  }
  if (!Array.isArray(owner_ids) || owner_ids.length === 0 || !owner_ids.every(id => Number.isSafeInteger(id) && id > 0)) {
    throw new ConfigError("owner_ids", "must list at least one Telegram user id");
  }
  return { token, chat_id, root_topic_id, owner_ids };
}

export async function loadSettings(file) {
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
  return validateSettings(raw);
}

export const emptyState = () => ({
  daemon: { pid: null, started_at: null, heartbeat_at: null, status: "stopped", error: null, bot: null },
  offset: 0,
  chats: [],
  topics: {},
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
  else if (state.chats.length < MAX_CHATS) state.chats.push(entry);
  else return false;
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
