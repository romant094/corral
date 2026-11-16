// /status and the pinned dashboard in the root topic: every live agent with its
// status, how long it has been in it, and a link to its topic.
import { escapeHtml, topicLink } from "./telegram.mjs";
import { EMOJI, topicName } from "./agents.mjs";

export function duration(ms) {
  const min = Math.floor(ms / 60000);
  if (min < 1) return "now";
  if (min < 60) return `${min} min`;
  const h = Math.floor(min / 60);
  return min % 60 ? `${h} h ${min % 60} min` : `${h} h`;
}

// Each row is named like the agent's topic: "[project] session title".
export function renderStatus(agents, state, chatId, now = Date.now()) {
  if (!agents.length) return "<b>No live agents</b>";
  const nameOf = (a) => state.agents[a.address]?.title ?? topicName(a.project, a.title);
  const rows = [...agents]
    .sort((a, b) => nameOf(a).localeCompare(nameOf(b)))
    .map(a => {
      const topic = state.agents[a.address]?.topic_id;
      const name = escapeHtml(nameOf(a));
      const label = topic ? `<a href="${topicLink(chatId, topic)}">${name}</a>` : name;
      return `${EMOJI[a.state] ?? EMOJI.idle} ${label} · ${a.state} · ${duration(now - a.since)}`;
    });
  return `<b>Agents (${agents.length})</b>\n${rows.join("\n")}`;
}

const tokens = (n) => n >= 1000 ? `${Math.round(n / 1000)}k` : String(n);

// /status in an agent's topic: the Corral card of that agent.
export async function renderAgent(agent, name, session, now = Date.now()) {
  const s = await session(agent.pid);
  const lines = [`<b>${escapeHtml(name)}</b>`, `${EMOJI[agent.state] ?? EMOJI.idle} ${agent.state} · ${duration(now - agent.since)}`];
  if (s) {
    const facts = [];
    if (s.model?.display_name) facts.push(escapeHtml(s.model.display_name));
    const ctx = s.context_window;
    if (ctx?.used_percentage != null) facts.push(`context ${Math.round(ctx.used_percentage)}%${ctx.total_input_tokens ? ` (${tokens(ctx.total_input_tokens)})` : ""}`);
    if (s.cost?.total_cost_usd != null) facts.push(`$${Number(s.cost.total_cost_usd).toFixed(2)}`);
    if (facts.length) lines.push(facts.join(" · "));
  }
  const home = process.env.HOME;
  const cwd = home && agent.cwd?.startsWith(home) ? `~${agent.cwd.slice(home.length)}` : agent.cwd;
  if (cwd) lines.push(`<code>${escapeHtml(cwd)}</code>`);
  return lines.join("\n");
}

// A fixed callback_data, not a registered button: the pinned dashboard lives
// for days and must not expire.
export const clearButton = (state) =>
  state.ended.length
    ? { inline_keyboard: [[{ text: `Clear all (${state.ended.length})`, callback_data: "clearask" }]] }
    : { inline_keyboard: [] };

export function makeDashboard({ api, settings, state, save, herd, log, throttleMs = 10000, now = () => Date.now() }) {
  const chat_id = settings.chat_id;
  let timer = null, at = 0, last = null, drawing = Promise.resolve();

  async function draw() {
    const time = new Date(now()).toTimeString().slice(0, 5);
    const text = `${renderStatus(herd.list(), state, chat_id, now())}\n\n<i>updated ${time}</i>`;
    const reply_markup = clearButton(state);
    const key = text.replace(/updated \d\d:\d\d/, "") + state.ended.length;
    if (key === last && state.dashboard_message_id) return;
    const id = state.dashboard_message_id;
    if (id) {
      try {
        await api.call("editMessageText", { chat_id, message_id: id, text, parse_mode: "HTML", reply_markup, link_preview_options: { is_disabled: true } });
        last = key;
        return;
      } catch (err) {
        if (/not modified/i.test(err.message)) { last = key; return; }
        if (!/not found|can't be edited|MESSAGE_ID_INVALID/i.test(err.message)) throw err;
        log("dashboard message is gone, posting a new one");
      }
    }
    const msg = await api.call("sendMessage", {
      chat_id, text, parse_mode: "HTML", reply_markup, disable_notification: true, link_preview_options: { is_disabled: true },
      ...(settings.root_topic_id ? { message_thread_id: settings.root_topic_id } : {}),
    });
    state.dashboard_message_id = msg.message_id;
    save();
    last = key;
    await api.call("pinChatMessage", { chat_id, message_id: msg.message_id, disable_notification: true })
      .catch(err => log(`pin dashboard: ${err.message}`));
  }

  // At most one edit per throttle window; the last state wins. Draws run one
  // after another, so a slow first post cannot be posted (and pinned) twice.
  function refresh() {
    if (timer) return;
    timer = setTimeout(() => {
      timer = null;
      at = now();
      drawing = drawing.then(draw).catch(err => log(`dashboard: ${err.message}`));
    }, Math.max(0, at + throttleMs - now()));
  }

  return { refresh, draw };
}
