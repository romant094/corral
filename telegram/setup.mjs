// What Corral's settings wizard asks of the bridge. Each mode prints one JSON object, so the mod
// never talks to Telegram itself and the token never goes on a command line.
import { rememberChat, rememberMessage, rememberTopic } from "./config.mjs";

// The rights the bridge uses: topics for agents, deleting messages in closed topics, the pinned dashboard.
export const RIGHTS = ["can_manage_topics", "can_delete_messages", "can_pin_messages"];

// Token, then group and rights when a group is set, then hc. Every failure is in `errors`;
// what could be learned is still there.
export async function check({ api, hc, settings }) {
  const out = { ok: true, bot: null, group: null, rights: null, hc: null, errors: [] };
  const fail = (what, err) => { out.ok = false; out.errors.push(`${what}: ${err.message}`); };
  try {
    const me = await api.call("getMe", {}, { tries: 1 });
    out.bot = { id: me.id, username: me.username, groups: !!me.can_join_groups, privacy: !me.can_read_all_group_messages };
    if (settings.chat_id) {
      try {
        const chat = await api.call("getChat", { chat_id: settings.chat_id }, { tries: 1 });
        out.group = { id: chat.id, title: chat.title, forum: !!chat.is_forum };
        if (!chat.is_forum) { out.ok = false; out.errors.push("group: Topics are off"); }
        const member = await api.call("getChatMember", { chat_id: settings.chat_id, user_id: me.id }, { tries: 1 });
        const admin = member.status === "creator" || member.status === "administrator";
        out.rights = { admin, missing: member.status === "creator" ? [] : RIGHTS.filter(r => !member[r]) };
        if (out.rights.missing.length) out.ok = false;
      } catch (err) { fail("group", err); }
    }
  } catch (err) {
    fail("bot", err.code === 401 ? { message: "the token was rejected" } : err);
  }
  try {
    const { terminals } = await hc.ls();
    out.hc = { agents: terminals.filter(t => t.agent === "claude-code").length };
  } catch (err) { fail("hc", err); }
  return out;
}

// Reads what waits for the bot without confirming it, so the daemon still gets every update later.
// Only while the daemon is stopped: two readers of one bot get 409 Conflict.
export async function discover({ api, state }) {
  const updates = await api.raw("getUpdates", { offset: state.offset, timeout: 0, allowed_updates: ["message", "my_chat_member"] });
  let changed = false;
  for (const u of updates) {
    if (u.my_chat_member) changed = rememberChat(state, u.my_chat_member.chat) || changed;
    if (u.message) changed = rememberMessage(state, u.message) || changed;
    // A topic the bot saw a message in, even without its name.
    const m = u.message;
    if (m?.is_topic_message && m.message_thread_id && m.chat?.type !== "private") {
      changed = rememberTopic(state, m.chat.id, m.message_thread_id, undefined) || changed;
    }
  }
  return { changed, found: listing(state) };
}

// Topics the bridge made for agents are not offered as the root topic.
export function listing(state) {
  const own = new Set([...Object.values(state.agents ?? {}).map(a => a.topic_id), ...(state.ended ?? []).map(e => e.topic_id)]);
  const topics = Object.fromEntries(Object.entries(state.topics).map(([chat, list]) => [chat, list.filter(t => !own.has(t.id))]));
  return { chats: state.chats, topics, people: state.people ?? [] };
}

// Pairing: Corral opens t.me/<bot>?startgroup=<code>&admin=…; Telegram lets the person pick a group and grants the
// rights, then sends "/start <code>" there from that person. That message names the group and the owner, and only
// someone with the code (shown in Corral) can send it. Groups without Topics are asked to turn them on and waited for.
// Updates are read and confirmed here: pairing runs while the daemon is stopped.
export const PAIR_RIGHTS = "manage_topics+delete_messages+pin_messages";
export const pairLink = (bot, code) => `https://t.me/${bot}?startgroup=${code}&admin=${PAIR_RIGHTS}`;

export async function pair({ api, state, code, seconds = 290, now = Date.now, wait = 25 }) {
  const me = await api.call("getMe", {}, { tries: 1 });
  const deadline = now() + seconds * 1000;
  const start = new RegExp(`^/start(@${me.username})?\\s+${code}$`, "i");
  let found = null, asked = null;
  while (now() < deadline) {
    const timeout = Math.max(0, Math.min(wait, Math.floor((deadline - now()) / 1000)));
    const updates = await api.raw("getUpdates", { offset: state.offset, timeout, allowed_updates: ["message", "my_chat_member"] });
    for (const u of updates) {
      state.offset = u.update_id + 1;
      if (u.my_chat_member) rememberChat(state, u.my_chat_member.chat);
      const m = u.message;
      if (!m) continue;
      rememberMessage(state, m);
      if (m.chat?.type !== "private" && start.test((m.text ?? "").trim()) && m.from && !m.from.is_bot) {
        found = { chat: m.chat, from: m.from };
      }
      // Turning Topics on moves a plain group to a supergroup with a new id.
      if (found && m.migrate_to_chat_id && m.chat?.id === found.chat.id) found.chat = { ...found.chat, id: m.migrate_to_chat_id };
    }
    if (!found) continue;
    const chat = await api.call("getChat", { chat_id: found.chat.id }, { tries: 1 });
    if (!chat.is_forum) {
      if (asked !== chat.id) {
        asked = chat.id;
        await api.call("sendMessage", { chat_id: chat.id,
          text: "Almost there: turn on Topics in this group (group settings → Topics). Corral finishes by itself then." }, { tries: 1 })
          .catch(() => {});
      }
      continue;
    }
    rememberChat(state, chat);
    const member = await api.call("getChatMember", { chat_id: chat.id, user_id: me.id }, { tries: 1 });
    const missing = member.status === "creator" ? [] : RIGHTS.filter(r => !member[r]);
    const f = found.from;
    const name = [f.first_name, f.last_name].filter(Boolean).join(" ") || f.username || String(f.id);
    await api.call("sendMessage", { chat_id: chat.id, disable_notification: true,
      text: missing.length ? `Connected to Corral, but the bot still needs: ${missing.join(", ")}.` : "Connected to Corral. /new starts an agent." },
      { tries: 1 }).catch(() => {});
    return { chat: { id: chat.id, title: chat.title }, owner: { id: f.id, login: f.username ?? null, name }, missing };
  }
  throw new Error(found ? "Topics are still off in that group" : "no group was connected in time");
}

// Brings the group's General topic back: shown, open, and with a fresh message, which is what makes a client
// that dropped it list it again. "Not modified" means it already was shown or open.
export async function restoreGeneral({ api, settings }) {
  if (!settings.chat_id) throw new Error("set the group first");
  const done = [];
  for (const method of ["unhideGeneralForumTopic", "reopenGeneralForumTopic"]) {
    try {
      await api.call(method, { chat_id: settings.chat_id }, { tries: 1 });
      done.push(method === "unhideGeneralForumTopic" ? "shown" : "reopened");
    } catch (err) {
      if (!/not.modified/i.test(err.message)) throw err;
    }
  }
  await api.call("sendMessage", { chat_id: settings.chat_id, text: "Corral's root topic is here: /new, /status, /clear.",
    disable_notification: true }, { tries: 1 });
  return { done };
}

export async function createTopic({ api, settings, state, name }) {
  if (!settings.chat_id) throw new Error("set the group first");
  const topic = await api.call("createForumTopic", { chat_id: settings.chat_id, name }, { tries: 1 });
  rememberTopic(state, settings.chat_id, topic.message_thread_id, topic.name ?? name);
  return { id: topic.message_thread_id, name: topic.name ?? name };
}
