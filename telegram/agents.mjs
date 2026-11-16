// Agents → Telegram: one forum topic per agent, its status in the topic name,
// the last reply on done, the screen and option buttons on blocked, and the
// close/delete path when the agent ends.
import { escapeHtml, splitText } from "./telegram.mjs";
import { tailScreen, parseDialog } from "./dialog.mjs";

export const EMOJI = { working: "⚡", blocked: "❓", done: "✅", idle: "💤", ended: "🏁" };
export const topicName = (state, where) => `${EMOJI[state] ?? EMOJI.idle} ${where}`.slice(0, 128);

// Telegram's ways of saying the topic is gone (deleted by hand in the group).
const TOPIC_GONE = /thread not found|TOPIC_ID_INVALID|TOPIC_DELETED|TOPIC_CLOSED/i;
const NOT_MODIFIED = /not modified/i;

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

export function makeSync({
  api, hc, settings, state, save, log, buttons, herd,
  lastReply, throttleMs = 10000, blockedDelayMs = 1500, now = () => Date.now(),
}) {
  const chat_id = settings.chat_id;
  const renames = new Map();   // address → { timer, at }
  const creating = new Map();  // address → Promise of the new topic
  const questions = new Map(); // address → { qid, message_id } of the latest blocked post
  const ending = new Map();    // address → "close" | "delete", set by /close
  let qids = 0;

  const send = (topicId, text, extra = {}) =>
    api.call("sendMessage", { chat_id, message_thread_id: topicId, text, parse_mode: "HTML", link_preview_options: { is_disabled: true }, ...extra });

  async function create(agent) {
    const topic = await api.call("createForumTopic", { chat_id, name: topicName(agent.state, agent.where) });
    state.agents[agent.address] = { topic_id: topic.message_thread_id, title: topic.name, state: agent.state };
    save();
    await send(topic.message_thread_id, `Started in <code>${escapeHtml(agent.cwd)}</code>`);
    return topic.message_thread_id;
  }

  // The agent's topic, made on first need. A topic deleted by hand is made again.
  async function topicOf(agent) {
    const known = state.agents[agent.address];
    if (known) return known.topic_id;
    if (!creating.has(agent.address)) {
      creating.set(agent.address, create(agent).finally(() => creating.delete(agent.address)));
    }
    return creating.get(agent.address);
  }

  // Runs fn(topicId); if Telegram says the topic is gone, makes a new one and tries once more.
  async function inTopic(agent, fn) {
    const id = await topicOf(agent);
    try {
      return await fn(id);
    } catch (err) {
      if (!TOPIC_GONE.test(err.message)) throw err;
      log(`topic of ${agent.address} is gone, making a new one`);
      delete state.agents[agent.address];
      return fn(await topicOf(agent));
    }
  }

  // Renames wait out the throttle and keep the last state: a flapping status
  // makes one rename, not ten ("topic renamed" lines land in the topic).
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

  async function rename(address) {
    const agent = herd.get(address);
    const known = state.agents[address];
    if (!agent || !known) return;
    const name = topicName(agent.state, agent.where);
    known.state = agent.state;
    if (known.title === name) return;
    try {
      await inTopic(agent, (id) => api.call("editForumTopic", { chat_id, message_thread_id: id, name }));
    } catch (err) {
      if (!NOT_MODIFIED.test(err.message)) throw err;
    }
    known.title = name;
    save();
  }

  async function postDone(agent) {
    const reply = await lastReply(agent.pid);
    const chunks = reply
      ? splitText(reply).map(escapeHtml)
      : splitText(tailScreen(await hc.read(agent.address), 20)).map(c => `<pre>${escapeHtml(c)}</pre>`);
    await inTopic(agent, async (id) => { for (const c of chunks) await send(id, c || "(empty)"); });
  }

  async function postBlocked(agent) {
    await sleep(blockedDelayMs);
    if (herd.get(agent.address)?.state !== "blocked") return;
    const screen = await hc.read(agent.address);
    const options = parseDialog(screen);
    const qid = ++qids;
    const reply_markup = options && {
      inline_keyboard: options.map(o => [{
        text: `${o.n} · ${o.label}`.slice(0, 64),
        callback_data: buttons.register({ type: "opt", address: agent.address, qid, n: o.n, label: o.label }),
      }]),
    };
    const body = `<b>❓ Waiting for you</b>\n<pre>${escapeHtml(tailScreen(screen, 25).slice(-3500))}</pre>`;
    const msg = await inTopic(agent, (id) => send(id, body, reply_markup ? { reply_markup } : {}));
    questions.set(agent.address, { qid, message_id: msg.message_id });
  }

  async function ended(agent) {
    const r = renames.get(agent.address);
    if (r?.timer) clearTimeout(r.timer);
    renames.delete(agent.address);
    questions.delete(agent.address);
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
    const title = topicName("ended", agent.where);
    await api.call("editForumTopic", { chat_id, message_thread_id: id, name: title }).catch(err => log(`rename ${id}: ${err.message}`));
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
      } else if (kind === "where") {
        scheduleRename(agent.address);
      } else if (kind === "state") {
        scheduleRename(agent.address);
        if (agent.state === "done") await postDone(agent);
        if (agent.state === "blocked") await postBlocked(agent);
      } else if (kind === "ended") {
        await ended(agent);
      }
    } catch (err) {
      log(`${kind} ${agent.address}: ${err.message}`);
    }
  }

  // After the first snapshot: agents that ended while the bridge was down.
  async function sweep() {
    for (const [address, known] of Object.entries(state.agents)) {
      if (herd.get(address)) continue;
      const where = known.title.replace(/^\S+\s/, "");
      await ended({ address, where });
    }
  }

  // /close: the herd's ended event finishes the job (rename or delete).
  async function endAgent(address, mode) {
    ending.set(address, mode);
    await hc.kill(address);
    // Removing the finished terminal makes Herdr.app close its tab.
    await hc.rm(address).catch(err => log(`rm ${address}: ${err.message}`));
  }

  const addressOf = (topicId) => Object.keys(state.agents).find(a => state.agents[a].topic_id === topicId) ?? null;

  return { handle, sweep, endAgent, addressOf, questions, send };
}
