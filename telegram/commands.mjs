// Telegram → agents: what a message or a button press in the group does.
import { escapeHtml } from "./telegram.mjs";
import { rememberChat, rememberMessage } from "./config.mjs";
import { renderStatus, renderAgent } from "./dashboard.mjs";
import { parseChoices } from "./dialog.mjs";
import { dialogKey } from "./agents.mjs";
import { projectOf } from "./herdr.mjs";
import { handleFile } from "./files.mjs";

// The bot's "≡" menu. Telegram has no per-topic menu, so each command says where it works.
export const COMMANDS = [
  { command: "new", description: "Start an agent in a workspace" },
  { command: "status", description: "All agents, or this agent in its topic" },
  { command: "stop", description: "Stop the current turn (Esc)" },
  { command: "close", description: "End the agent, close or delete its topic" },
  { command: "clear", description: "Delete the topics of ended agents" },
  { command: "help", description: "What the bot can do here" },
];

const ROOT_ONLY = new Set(["new", "clear"]);
const AGENT_ONLY = new Set(["stop", "close"]);

const HELP_ROOT = [
  "<b>Root topic</b>",
  "/new — start Claude in a workspace",
  "/status — all agents and their status",
  "/clear — delete the topics of ended agents",
  "Agent commands (/stop /close) work in an agent's topic.",
].join("\n");

const HELP_AGENT = [
  "<b>Agent topic</b>",
  "Text — a prompt for the agent. While it waits at a dialog: 1…9, y, n, enter, esc, or the buttons.",
  "Photo or file — saved and passed to the agent with your caption.",
  "/status — this agent: status, model, context, cost",
  "/stop — stop the current turn (Esc)",
  "/close — end the agent, close or delete this topic",
  "Other commands (/compact, /model…) go to Claude as typed.",
].join("\n");

// The tab /new puts Claude into, to the right of what is there: the space's
// tab with Claude agents in it, else its first tab. Null: a tab of its own.
export function tabFor(space, isAgent) {
  const terminals = (node) => node?.content?.terminal ? [node.content.terminal] : (node?.children ?? []).flatMap(terminals);
  const tabs = space.tabs ?? [];
  return (tabs.find(t => terminals(t.root).some(isAgent)) ?? tabs[0])?.id ?? null;
}

const SHORT_KEYS = new Map([
  ["y", "y"], ["n", "n"], ["enter", "enter"], ["esc", "esc"],
  ...["1", "2", "3", "4", "5", "6", "7", "8", "9"].map(d => [d, d]),
]);

// What plain text in an agent's topic does, as data so it can be tested alone.
export function routeText(agentState, text) {
  const key = SHORT_KEYS.get(text.trim().toLowerCase());
  if (agentState === "blocked") {
    return key ? { keys: [key] } : { refuse: "⚠️ The agent is waiting at a dialog. Answer with a button, 1…9, y, n, enter or esc." };
  }
  return { send: text };
}

export function parseCommand(text) {
  const m = /^\/([a-z_]+)(?:@(\S+))?(?:\s+([\s\S]*))?$/i.exec(text?.trim() ?? "");
  return m ? { name: m[1].toLowerCase(), bot: m[2]?.toLowerCase() ?? null, args: (m[3] ?? "").trim() } : null;
}

const OURS = new Set(COMMANDS.map(c => c.command));

// Telegram keeps updates for 24 h. Text written while the bridge was down must
// not answer whatever dialog is open now.
export const STALE_SECONDS = 120;

export function makeCommands({
  api, hc, settings, state, save, herd, sync, buttons, dashboard, inbox, log,
  bot = null, nowSec = () => Date.now() / 1000, session = async () => null, noticeMs = 5000,
}) {
  const chat_id = settings.chat_id;
  const owners = new Set(settings.owner_ids);
  const closeAsks = new Map(); // address → number of the latest /close question
  let closeIds = 0;

  // The message goes; a short notice says why and goes after noticeMs.
  async function dropInEnded(msg) {
    await api.call("deleteMessage", { chat_id, message_id: msg.message_id }).catch(err => log(`delete message: ${err.message}`));
    const notice = await api.call("sendMessage", {
      chat_id, message_thread_id: msg.message_thread_id, text: "Agent has ended. Messages here are not kept.", disable_notification: true,
    }).catch(err => log(`notice: ${err.message}`));
    if (notice?.message_id) {
      setTimeout(() => api.call("deleteMessage", { chat_id, message_id: notice.message_id }).catch(() => {}), noticeMs);
    }
  }

  const reply = (msg, text, extra = {}) =>
    api.call("sendMessage", {
      chat_id, text, parse_mode: "HTML", link_preview_options: { is_disabled: true },
      ...(msg.is_topic_message ? { message_thread_id: msg.message_thread_id } : {}),
      reply_parameters: { message_id: msg.message_id, allow_sending_without_reply: true },
      ...extra,
    });

  const where = (cmd) => ROOT_ONLY.has(cmd) ? "Use /" + cmd + " in the root topic." : "Use /" + cmd + " in an agent's topic.";

  // Remembers groups and topics for the settings wizard; true when state changed.
  function remember(msg) {
    return rememberMessage(state, msg);
  }

  async function onRootCommand(msg, cmd) {
    if (cmd.name === "new") {
      const spaces = (await hc.spaces()).filter(s => s.folder);
      if (!spaces.length) return reply(msg, "No workspaces in Herdr.");
      const rows = spaces.map(s => [{ text: s.name || s.folder, callback_data: buttons.register({
        type: "new", space: { id: s.id, name: s.name, folder: s.folder }, tab: tabFor(s, (t) => !!herd.get(t)),
      }) }]);
      return reply(msg, "Start Claude in which workspace?", { reply_markup: { inline_keyboard: rows } });
    }
    if (cmd.name === "clear") return askClear(msg);
  }

  // The confirm press deletes exactly the topics the question counted.
  async function askClear(msg) {
    const n = state.ended.length;
    if (!n) return reply(msg, "Nothing to clear.");
    return reply(msg, `Delete ${n} topic${n === 1 ? "" : "s"} of ended agents?`, {
      reply_markup: { inline_keyboard: [[
        { text: "Delete all", callback_data: buttons.register({ type: "clear", topics: state.ended.map(e => e.topic_id) }) },
        { text: "Cancel", callback_data: buttons.register({ type: "cancel" }) },
      ]] },
    });
  }

  async function onAgentCommand(msg, cmd, agent) {
    if (cmd.name === "stop") {
      await hc.keys(agent.address, "esc");
      return reply(msg, "⏹ sent esc");
    }
    if (cmd.name === "close") {
      const cq = ++closeIds;
      const ask = (mode) => buttons.register({ type: "close", address: agent.address, mode, cq });
      const ids = { close: ask("close"), delete: ask("delete"), cancel: ask("cancel") };
      closeAsks.set(agent.address, cq);
      return reply(msg, `End <b>${escapeHtml(await sync.nameOf(agent))}</b>?`, {
        reply_markup: { inline_keyboard: [
          [{ text: "End & close topic", callback_data: ids.close }],
          [{ text: "End & delete topic", callback_data: ids.delete }],
          [{ text: "Cancel", callback_data: ids.cancel }],
        ] },
      });
    }
  }

  async function onMessage(msg) {
    if (remember(msg)) save();
    if (msg.chat?.id !== chat_id) return;
    if (!owners.has(msg.from?.id)) {
      log(`ignored a message from user ${msg.from?.id ?? "?"}`);
      return;
    }
    const thread = msg.is_topic_message ? msg.message_thread_id : null;
    const isRoot = thread === settings.root_topic_id;
    const address = thread ? sync.addressOf(thread) : null;
    const agent = address ? herd.get(address) : null;
    const endedTopic = thread && state.ended.some(e => e.topic_id === thread);
    let cmd = msg.text ? parseCommand(msg.text) : null;
    // /stop@other_bot is for another bot in the group.
    if (cmd?.bot && bot && cmd.bot !== bot.toLowerCase()) return;
    // In an agent's topic, a slash command that is not ours is Claude's own
    // (/compact, /model, /cost…): it goes to the agent as text.
    if (cmd && agent && !OURS.has(cmd.name)) cmd = null;

    // A closed topic still takes messages from admins (the owner is one), and
    // Telegram cannot stop that: the bridge removes them instead.
    if (endedTopic) return dropInEnded(msg);

    if (cmd) {
      if (cmd.name === "status") {
        if (agent) return reply(msg, await renderAgent(agent, await sync.nameOf(agent), session));
        return reply(msg, renderStatus(herd.list(), state, chat_id));
      }
      if (cmd.name === "help") return reply(msg, agent ? HELP_AGENT : HELP_ROOT);
      // /init is the setup command (Corral's settings pair the group with it); here the group is connected already.
      if (cmd.name === "init" || cmd.name === "start") return reply(msg, "Already set up: this group is connected to Corral. /help lists the commands.");
      if (ROOT_ONLY.has(cmd.name)) return isRoot ? onRootCommand(msg, cmd) : reply(msg, where(cmd.name));
      if (AGENT_ONLY.has(cmd.name)) {
        if (agent) return onAgentCommand(msg, cmd, agent);
        return reply(msg, address ? "Claude is still starting." : where(cmd.name));
      }
      return reply(msg, "Unknown command. /help lists them.");
    }

    if (!agent) {
      if (address) return reply(msg, "Claude is still starting. Answer its question with the buttons above.");
      return; // root or another topic: plain talk is left alone
    }

    if (nowSec() - (msg.date ?? nowSec()) > STALE_SECONDS) {
      return reply(msg, "⚠️ Sent while the bridge was offline, so not delivered. Send it again if it still applies.");
    }

    try {
      if (msg.photo || msg.document) {
        const answer = await handleFile({ msg, agent, api, hc, inbox });
        if (answer) await reply(msg, answer);
        return;
      }
      if (!msg.text) return;
      const route = routeText(agent.state, msg.text);
      if (route.refuse) return reply(msg, route.refuse);
      if (route.keys) return await hc.keys(agent.address, ...route.keys);
      return await hc.send(agent.address, route.send);
    } catch (err) {
      log(`deliver to ${agent.address}: ${err.message}`);
      return reply(msg, `⚠️ Not delivered: ${escapeHtml(err.message)}`);
    }
  }

  const answer = (q, text) => api.call("answerCallbackQuery", { callback_query_id: q.id, ...(text ? { text } : {}) });
  const edit = (q, text) => api.call("editMessageText", {
    chat_id, message_id: q.message.message_id, text, parse_mode: "HTML", reply_markup: { inline_keyboard: [] },
  }).catch(err => log(`edit: ${err.message}`));

  async function deleteTopic(topicId) {
    try {
      await api.call("deleteForumTopic", { chat_id, message_thread_id: topicId });
    } catch (err) {
      // Already gone by hand: drop it from the list all the same.
      if (!/thread not found|TOPIC_ID_INVALID/i.test(err.message)) throw err;
    }
    state.ended = state.ended.filter(e => e.topic_id !== topicId);
    save();
  }

  async function onCallback(q) {
    if (q.message?.chat?.id !== chat_id || !owners.has(q.from?.id)) {
      log(`ignored a button press from user ${q.from?.id ?? "?"}`);
      return answer(q, "Not allowed.");
    }
    const entry = q.data === "clearask" ? { type: "clearask" } : buttons.get(q.data);
    if (!entry) return answer(q, "This button has expired.");

    switch (entry.type) {
      case "opt": {
        const open = sync.questions.get(entry.address);
        // A question before Claude starts has no blocked status: a live terminal is enough.
        const waiting = open?.pending ? !!herd.live(entry.address) : herd.get(entry.address)?.state === "blocked";
        if (!open || open.qid !== entry.qid || !waiting) {
          return answer(q, "This question is no longer open.");
        }
        // Claude can go from one dialog to the next without leaving blocked:
        // the key goes only to the dialog the button was made for.
        try {
          if (dialogKey(parseChoices(await hc.read(entry.address))) !== open.labels) {
            return answer(q, "The dialog has changed.");
          }
          await hc.keys(entry.address, ...entry.keys);
        } catch (err) {
          log(`option ${entry.address}: ${err.message}`);
          return answer(q, `Not delivered: ${err.message}`.slice(0, 190));
        }
        sync.questions.delete(entry.address);
        await answer(q);
        return api.call("editMessageReplyMarkup", {
          chat_id, message_id: q.message.message_id,
          reply_markup: { inline_keyboard: [[{ text: `✅ ${entry.n} · ${entry.label}`.slice(0, 64), callback_data: "noop" }]] },
        }).catch(err => log(`edit buttons: ${err.message}`));
      }
      case "close": {
        if (closeAsks.get(entry.address) !== entry.cq || !herd.get(entry.address)) {
          await answer(q, "This question is no longer open.");
          return edit(q, "Not closed.");
        }
        closeAsks.delete(entry.address);
        if (entry.mode === "cancel") { await answer(q); return edit(q, "Not closed."); }
        await answer(q);
        await edit(q, entry.mode === "delete" ? "Ending, the topic will be deleted…" : "Ending…");
        try {
          return await sync.endAgent(entry.address, entry.mode);
        } catch (err) {
          log(`end ${entry.address}: ${err.message}`);
          return edit(q, `⚠️ Could not end the agent: ${escapeHtml(err.message)}`);
        }
      }
      case "deltopic": {
        if (!state.ended.some(e => e.topic_id === entry.topic_id)) return answer(q, "Nothing to delete.");
        await answer(q);
        return deleteTopic(entry.topic_id);
      }
      case "clearask": {
        await answer(q);
        return askClear({ ...q.message, message_id: q.message.message_id });
      }
      case "clear": {
        buttons.drop(q.data);
        const list = state.ended.filter(e => entry.topics.includes(e.topic_id));
        await answer(q);
        let n = 0;
        for (const e of list) {
          try { await deleteTopic(e.topic_id); n++; } catch (err) { log(`delete topic ${e.topic_id}: ${err.message}`); }
        }
        dashboard.refresh();
        return edit(q, `Deleted ${n} topic${n === 1 ? "" : "s"}.`);
      }
      case "cancel": {
        await answer(q);
        return edit(q, "Cancelled.");
      }
      case "new": {
        buttons.drop(q.data);
        await answer(q);
        const name = escapeHtml(entry.space.name || entry.space.folder);
        await edit(q, `Starting Claude in <b>${name}</b>…`);
        let started;
        try {
          started = await hc.startClaude(entry.space, entry.tab);
        } catch (err) {
          return edit(q, `⚠️ Claude did not start in <b>${name}</b>: ${escapeHtml(err.message)}`);
        }
        await edit(q, `Started Claude in <b>${name}</b>.`);
        // Its topic now, before Claude reports anything: a first question lands there.
        return sync.starting(herd.live(started.address) ?? {
          address: started.address, cwd: entry.space.folder, title: "",
          project: projectOf(`${entry.space.name} / `, entry.space.folder),
        });
      }
      default:
        return answer(q);
    }
  }

  async function handle(update) {
    if (update.my_chat_member) {
      if (rememberChat(state, update.my_chat_member.chat)) save();
      return;
    }
    if (update.callback_query) {
      if (update.callback_query.data === "noop") return answer(update.callback_query);
      return onCallback(update.callback_query);
    }
    if (update.message) return onMessage(update.message);
  }

  return { handle };
}
