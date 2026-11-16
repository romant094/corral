// Agents → Telegram: one forum topic per agent, named "[project] session title",
// its status as the topic icon, the last reply on done, the screen and option
// buttons when it waits, and the close/delete path when it ends.
import { escapeHtml, splitText } from "./telegram.mjs";
import { richParts } from "./format.mjs";
import { tailScreen, parseChoices } from "./dialog.mjs";

export const EMOJI = { starting: "🎬", working: "⚡", blocked: "❓", done: "✅", idle: "☕", ended: "🏁" };

// Topic icons come from Telegram's own set (getForumTopicIconStickers); an
// emoji in the name shows on some clients only. The first emoji of each list is
// in the set every group can use without Premium; the others stand in if
// Telegram changes it.
const ICON_CHOICES = {
  starting: ["🎬", "👀"],
  working: ["⚡", "🔥"],
  blocked: ["❓", "⁉", "❗"],
  done: ["✅", "🏆"],
  idle: ["☕", "💬"],
  ended: ["🏁", "🏆"],
};
const bare = (e) => String(e ?? "").replace(/️/g, "");

export function pickIcons(stickers) {
  const byEmoji = new Map((stickers ?? []).map(s => [bare(s.emoji), s.custom_emoji_id]));
  return Object.fromEntries(Object.entries(ICON_CHOICES).map(([state, list]) => [state, list.map(e => byEmoji.get(bare(e))).find(Boolean) ?? null]));
}

export async function loadIcons(api, log = () => {}) {
  try {
    const stickers = await api.call("getForumTopicIconStickers", {});
    const icons = pickIcons(stickers);
    const byId = new Map((stickers ?? []).map(s => [s.custom_emoji_id, s.emoji]));
    log(`topic icons: ${Object.entries(icons).map(([k, id]) => `${k} ${id ? byId.get(id) : "none"}`).join(", ")}`);
    return icons;
  } catch (err) {
    log(`topic icons: ${err.message}`);
    return pickIcons([]);
  }
}

export const topicName = (project, title) => `[${project}] ${title || "new session"}`.slice(0, 128);

// Telegram's ways of saying the topic is gone (deleted by hand in the group).
const TOPIC_GONE = /thread not found|TOPIC_ID_INVALID|TOPIC_DELETED/i;
const TOPIC_CLOSED = /TOPIC_CLOSED/i;
const NOT_MODIFIED = /not.modified/i; // "message is not modified", "TOPIC_NOT_MODIFIED"

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// What a dialog asks, to tell one dialog from the next while the agent waits.
export const dialogKey = (options) => (options ?? []).map(o => `${o.n}.${o.label}`).join("|");

export function makeSync({
  api, hc, settings, state, save, log, buttons, herd, icons = {},
  lastReply, session = async () => null, throttleMs = 10000, blockedDelayMs = 1500, now = () => Date.now(),
  replyTries = 6, replyRetryMs = 500, startCheckMs = 5000, startGiveUpMs = 300000,
}) {
  const chat_id = settings.chat_id;
  const posted = new Map();    // address → the last reply posted, to tell a new one
  const renames = new Map();   // address → { timer, at }
  const creating = new Map();  // address → Promise of the new topic
  const questions = new Map(); // address → { qid, message_id, labels, pending } of the latest question
  const ending = new Map();    // address → "close" | "delete", set by /close
  let qids = 0;

  const send = (topicId, text, extra = {}) =>
    api.call("sendMessage", { chat_id, message_thread_id: topicId, text, parse_mode: "HTML", link_preview_options: { is_disabled: true }, ...extra });

  // The card's title: the terminal title Claude sets, else the session name the statusline saw.
  async function nameOf(agent) {
    const title = agent.title || (await session(agent.pid))?.session_name || "";
    return topicName(agent.project, title);
  }

  async function create(agent, name, iconState) {
    const icon = icons[iconState];
    const topic = await api.call("createForumTopic", { chat_id, name, ...(icon ? { icon_custom_emoji_id: icon } : {}) });
    state.agents[agent.address] = { topic_id: topic.message_thread_id, title: topic.name, icon: icon ?? null, icon_ok: !!icon, state: iconState };
    save();
    await send(topic.message_thread_id, `Started in <code>${escapeHtml(agent.cwd)}</code>`);
    return topic.message_thread_id;
  }

  // The agent's topic, made on first need. A topic deleted by hand is made again.
  async function topicOf(agent, name, iconState = agent.state) {
    const known = state.agents[agent.address];
    if (known) return known.topic_id;
    if (!creating.has(agent.address)) {
      const make = async () => create(agent, name ?? await nameOf(agent), iconState);
      creating.set(agent.address, make().finally(() => creating.delete(agent.address)));
    }
    return creating.get(agent.address);
  }

  // Runs fn(topicId). A topic closed by hand is reopened; a topic deleted by
  // hand is made again, but only while the agent lives and the topic is still
  // its own: a call that raced /close must not bring a deleted topic back.
  async function inTopic(agent, fn) {
    const id = await topicOf(agent);
    try {
      return await fn(id);
    } catch (err) {
      if (TOPIC_CLOSED.test(err.message)) {
        await api.call("reopenForumTopic", { chat_id, message_thread_id: id });
        return fn(id);
      }
      if (!TOPIC_GONE.test(err.message)) throw err;
      if (!herd.live(agent.address) || state.agents[agent.address]?.topic_id !== id) throw err;
      log(`topic of ${agent.address} is gone, making a new one`);
      delete state.agents[agent.address];
      return fn(await topicOf(agent));
    }
  }

  // Renames wait out the throttle and keep the last state: a flapping status
  // makes one edit, not ten ("topic edited" lines land in the topic).
  function scheduleRename(address) {
    const r = renames.get(address) ?? { timer: null, at: 0 };
    renames.set(address, r);
    if (r.timer) return;
    r.timer = setTimeout(() => {
      r.timer = null;
      r.at = now();
      rename(address).catch(err => log(`rename ${address}: ${err.message}`));
    }, Math.max(0, r.at + throttleMs - now()));
  }

  async function bounceIcon(topicId, icon) {
    const other = Object.values(icons).find(i => i && i !== icon);
    if (!other) return;
    await api.call("editForumTopic", { chat_id, message_thread_id: topicId, icon_custom_emoji_id: other });
    await api.call("editForumTopic", { chat_id, message_thread_id: topicId, icon_custom_emoji_id: icon });
  }

  async function rename(address) {
    const agent = herd.get(address);
    const known = state.agents[address];
    if (!agent || !known) return;
    const name = await nameOf(agent);
    const icon = icons[agent.state] ?? null;
    known.state = agent.state;
    // Only what changed goes: Telegram answers "not modified" to an edit whose
    // name is the same, and then keeps the old icon. An icon counts as set only
    // after Telegram took it (icon_ok); older state is checked once.
    const newName = known.title !== name;
    const newIcon = !!icon && (known.icon !== icon || !known.icon_ok);
    if (!newName && !newIcon) return;
    try {
      await inTopic(agent, (id) => api.call("editForumTopic", {
        chat_id, message_thread_id: id, ...(newName ? { name } : {}), ...(newIcon ? { icon_custom_emoji_id: icon } : {}),
      }));
    } catch (err) {
      if (!NOT_MODIFIED.test(err.message)) throw err;
      // Telegram can hold an icon its clients never got (an edit it answered
      // "not modified"). Another icon and back makes a real change they see.
      if (newIcon && !known.icon_ok) await bounceIcon(known.topic_id, icon);
    }
    known.title = name;
    known.icon = icon;
    known.icon_ok = !!icon;
    save();
    // The log stays in English: the session title (any language) is in the topic, not here.
    log(`${address} ${agent.state}, topic ${known.topic_id}${newName ? ", renamed" : ""}`);
  }

  // Claude Code can report done before the reply reaches the transcript. A
  // reply equal to the one posted last time is the previous turn's: wait and
  // read again, then give up and post the screen.
  async function freshReply(agent) {
    for (let i = 0; i < replyTries; i++) {
      const reply = await lastReply(agent.pid);
      if (reply && reply !== posted.get(agent.address)) {
        posted.set(agent.address, reply);
        return reply;
      }
      await sleep(replyRetryMs);
    }
    return null;
  }

  // Claude writes Markdown, and a rich message (Bot API 10.x) renders it: headings, bold, code, lists, tables.
  // format.mjs folds a long reply into <details> sections. If Telegram refuses one, it goes as plain text.
  const sendRich = (topicId, markdown) => api.call("sendRichMessage", {
    chat_id, message_thread_id: topicId, rich_message: { markdown, skip_entity_detection: false },
  });

  async function postDone(agent) {
    const reply = await freshReply(agent);
    if (reply && settings.reply_format === "markdown") {
      await inTopic(agent, async (id) => { for (const c of splitText(reply)) await send(id, escapeHtml(c) || "(empty)"); });
      return;
    }
    if (reply) {
      await inTopic(agent, async (id) => {
        for (const part of richParts(reply, { fold: settings.fold_chars ?? 1200 })) {
          try { await sendRich(id, part); } catch (err) {
            // A gone or closed topic is inTopic's to handle; anything else about the rich message falls back.
            if (TOPIC_GONE.test(err.message) || TOPIC_CLOSED.test(err.message)) throw err;
            log(`rich message refused (${err.message}); sent as plain text`);
            for (const c of splitText(part)) await send(id, escapeHtml(c) || "(empty)");
          }
        }
      });
      return;
    }
    // Done for a moment mid-turn (a dialog closing, say): the turn goes on and its reply comes with the next done.
    if (herd.get(agent.address)?.state !== "done") return;
    const chunks = splitText(tailScreen(await hc.read(agent.address), 20)).map(c => `<pre>${escapeHtml(c)}</pre>`);
    await inTopic(agent, async (id) => { for (const c of chunks) await send(id, c || "(empty)"); });
  }

  // The screen and one button per choice. `pending`: Claude has not reported a
  // status yet (a question before it starts, such as trusting the folder).
  async function postQuestion(agent, screen, pending = false) {
    const options = parseChoices(screen);
    const qid = ++qids;
    const reply_markup = options && {
      inline_keyboard: options.map(o => [{
        text: `${o.n} · ${o.label}`.slice(0, 64),
        callback_data: buttons.register({ type: "opt", address: agent.address, qid, keys: o.keys, n: o.n, label: o.label }),
      }]),
    };
    const body = `<b>❓ Waiting for you</b>\n<pre>${escapeHtml(tailScreen(screen, 25).slice(-3500))}</pre>`;
    const msg = await inTopic(agent, (id) => send(id, body, reply_markup ? { reply_markup } : {}));
    questions.set(agent.address, { qid, message_id: msg.message_id, labels: dialogKey(options), pending });
  }

  // The dialog needs a moment to draw. The wait is a timer, not part of the
  // event queue, so one blocked agent does not hold up the others.
  function scheduleBlocked(agent) {
    setTimeout(async () => {
      try {
        if (herd.get(agent.address)?.state !== "blocked") return;
        await postQuestion(agent, await hc.read(agent.address));
      } catch (err) {
        log(`blocked ${agent.address}: ${err.message}`);
      }
    }, blockedDelayMs);
  }

  // /new: the topic comes at once, before Claude reports anything. Until it
  // does, the bridge looks at the screen now and then: a question there (trust
  // this folder?) is posted with its buttons. A terminal that ends first gets
  // the ended path.
  async function starting(agent) {
    if (!state.agents[agent.address]) await topicOf(agent, topicName(agent.project, "starting"), "starting");
    const since = now();
    let shown = null;
    // unref: a watch must not keep the process alive on its own.
    const later = () => setTimeout(check, startCheckMs).unref?.();
    const check = async () => {
      if (herd.get(agent.address) || !state.agents[agent.address]) return;
      const t = herd.live(agent.address);
      if (!t?.running && now() - since >= startCheckMs) return ended(agent);
      if (now() - since > startGiveUpMs) return;
      try {
        const screen = await hc.read(agent.address);
        const key = dialogKey(parseChoices(screen));
        if (key && key !== shown) { shown = key; await postQuestion(agent, screen, true); }
      } catch (err) {
        log(`starting ${agent.address}: ${err.message}`);
      }
      later();
    };
    later();
  }

  async function ended(agent) {
    const r = renames.get(agent.address);
    if (r?.timer) clearTimeout(r.timer);
    renames.delete(agent.address);
    questions.delete(agent.address);
    posted.delete(agent.address);
    const mode = ending.get(agent.address);
    ending.delete(agent.address);
    const known = state.agents[agent.address];
    if (!known) return;
    delete state.agents[agent.address];
    save();
    const id = known.topic_id;
    if (mode === "delete") {
      await api.call("deleteForumTopic", { chat_id, message_thread_id: id }).catch(err => log(`delete topic ${id}: ${err.message}`));
      return;
    }
    // The 🏁 icon marks it; without one in Telegram's set, the name carries it.
    const icon = icons.ended;
    const title = icon ? known.title : `🏁 ${known.title}`.slice(0, 128);
    await api.call("editForumTopic", { chat_id, message_thread_id: id, ...(icon ? { icon_custom_emoji_id: icon } : { name: title }) })
      .catch(err => log(`rename ${id}: ${err.message}`));
    await send(id, "🏁 Agent ended", {
      reply_markup: { inline_keyboard: [[{ text: "Delete topic", callback_data: buttons.register({ type: "deltopic", topic_id: id }) }]] },
    }).catch(err => log(`post ${id}: ${err.message}`));
    await api.call("closeForumTopic", { chat_id, message_thread_id: id }).catch(err => log(`close topic ${id}: ${err.message}`));
    state.ended.push({ topic_id: id, title, ended_at: new Date(now()).toISOString() });
    save();
  }

  // One change from the herd. Errors are logged: one bad call must not stop the stream.
  async function handle(change) {
    const { kind, agent } = change;
    try {
      if (kind === "added") {
        if (state.agents[agent.address]) scheduleRename(agent.address);
        else await topicOf(agent);
        // Blocked already when first seen (or while the bridge was down): ask now.
        if (agent.state === "blocked") scheduleBlocked(agent);
      } else if (kind === "where") {
        scheduleRename(agent.address);
      } else if (kind === "state") {
        scheduleRename(agent.address);
        if (agent.state === "done") await postDone(agent);
        if (agent.state === "blocked") scheduleBlocked(agent);
      } else if (kind === "ended") {
        await ended(agent);
      }
    } catch (err) {
      log(`${kind} ${agent.address}: ${err.message}`);
    }
  }

  // After the first snapshot: agents that ended while the bridge was down.
  async function sweep() {
    for (const address of Object.keys(state.agents)) {
      // Still an agent, or Claude still starting there: keep.
      if (herd.get(address) || herd.live(address)?.running) continue;
      await ended({ address });
    }
  }

  // /close: the herd's ended event finishes the job (rename or delete).
  // A failed kill disarms the choice: the agent ending later at the desk must
  // not delete a topic because of a press that did not work.
  async function endAgent(address, mode) {
    ending.set(address, mode);
    try {
      await hc.kill(address);
    } catch (err) {
      ending.delete(address);
      throw err;
    }
    // Removing the finished terminal makes Herdr.app close its pane.
    await hc.rm(address).catch(err => log(`rm ${address}: ${err.message}`));
  }

  const addressOf = (topicId) => Object.keys(state.agents).find(a => state.agents[a].topic_id === topicId) ?? null;

  return { handle, sweep, starting, endAgent, addressOf, questions, send, ending, nameOf };
}
