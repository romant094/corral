#!/usr/bin/env node
// Corral's Telegram bridge: Herdr agents ↔ topics of a Telegram forum group.
//   node bridge.mjs           run in the foreground (launchd runs it the same way)
//   node bridge.mjs --check   check settings, bot, group and hc; sends nothing
import { readFile, writeFile, unlink, mkdir } from "node:fs/promises";
import { writeFileSync, unlinkSync } from "node:fs";
import { paths, loadSettings, loadState, saveState } from "./config.mjs";
import { makeApi } from "./telegram.mjs";
import { makeHc, makeHerd } from "./herdr.mjs";
import { makeSync } from "./agents.mjs";
import { makeButtons } from "./buttons.mjs";
import { makeDashboard } from "./dashboard.mjs";
import { makeCommands, COMMANDS } from "./commands.mjs";
import { lastReply } from "./transcript.mjs";

const log = (...a) => console.error(new Date().toISOString(), ...a);
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const P = paths();

async function check() {
  let ok = true;
  const line = (good, what, detail) => { ok &&= good; console.log(`${good ? "OK  " : "FAIL"} ${what}${detail ? `: ${detail}` : ""}`); };
  let settings;
  try {
    settings = await loadSettings(P.settings);
    line(true, "settings", P.settings);
  } catch (err) {
    line(false, "settings", err.message);
  }
  const hc = makeHc();
  try {
    const { terminals } = await hc.ls();
    line(true, "hc", `${terminals.filter(t => t.agent === "claude-code").length} Claude agents`);
  } catch (err) {
    line(false, "hc", err.message);
  }
  if (settings) {
    const api = makeApi(settings.token);
    try {
      const me = await api.call("getMe", {}, { tries: 1 });
      line(true, "bot", `@${me.username}`);
      const chat = await api.call("getChat", { chat_id: settings.chat_id }, { tries: 1 });
      line(!!chat.is_forum, "group", `${chat.title}${chat.is_forum ? "" : " (Topics are off)"}`);
      const member = await api.call("getChatMember", { chat_id: settings.chat_id, user_id: me.id }, { tries: 1 });
      const rights = ["can_manage_topics", "can_delete_messages", "can_pin_messages"];
      const missing = member.status === "creator" ? [] : rights.filter(r => !member[r]);
      line(missing.length === 0, "bot rights", missing.length ? `missing ${missing.join(", ")}` : "manage topics, delete, pin");
    } catch (err) {
      line(false, "telegram", err.message);
    }
  }
  process.exit(ok ? 0 : 1);
}

// One bridge per machine: two would both poll Telegram and fight (409 Conflict).
async function lock() {
  await mkdir(P.dir, { recursive: true });
  try {
    await writeFile(P.lock, String(process.pid), { flag: "wx" });
    return;
  } catch {}
  const pid = Number(await readFile(P.lock, "utf8").catch(() => ""));
  let alive = false;
  try { if (pid) { process.kill(pid, 0); alive = true; } } catch {}
  if (alive && pid !== process.pid) {
    console.error(`The bridge already runs (pid ${pid}).`);
    process.exit(1);
  }
  await writeFile(P.lock, String(process.pid));
}

async function run() {
  await lock();
  const state = await loadState(P.state);
  let saveTimer = null;
  const save = () => {
    if (saveTimer) return;
    saveTimer = setTimeout(() => { saveTimer = null; saveState(P.state, state).catch(err => log(`save state: ${err.message}`)); }, 300);
  };
  const fail = async (why) => {
    log(why);
    state.daemon = { ...state.daemon, status: "error", error: why };
    await saveState(P.state, state).catch(() => {});
  };

  let settings;
  try {
    settings = await loadSettings(P.settings);
  } catch (err) {
    await fail(err.message);
    await unlink(P.lock).catch(() => {});
    process.exit(1);
  }

  // TG_API_BASE points the bridge at a stand-in server for a smoke test.
  const api = makeApi(settings.token, process.env.TG_API_BASE ? { base: process.env.TG_API_BASE } : {});
  let me;
  try {
    me = await api.call("getMe");
  } catch (err) {
    await fail(`bot: ${err.message}`);
    await unlink(P.lock).catch(() => {});
    process.exit(1);
  }

  state.daemon = { pid: process.pid, started_at: new Date().toISOString(), heartbeat_at: new Date().toISOString(), status: "running", error: null, bot: me.username };
  await saveState(P.state, state);
  log(`bridge started as @${me.username}`);

  const stop = () => {
    state.daemon = { ...state.daemon, status: "stopped", pid: null };
    try { writeFileSync(P.state, JSON.stringify(state, null, 2)); } catch {}
    try { unlinkSync(P.lock); } catch {}
    process.exit(0);
  };
  process.on("SIGTERM", stop);
  process.on("SIGINT", stop);

  await api.call("setMyCommands", { commands: COMMANDS, scope: { type: "chat", chat_id: settings.chat_id } })
    .catch(err => log(`set commands: ${err.message}`));

  const hc = makeHc();
  const herd = makeHerd();
  const buttons = makeButtons();
  const dashboard = makeDashboard({ api, settings, state, save, herd, buttons, log });
  const sync = makeSync({ api, hc, settings, state, save, log, buttons, herd, lastReply });
  const commands = makeCommands({ api, hc, settings, state, save, herd, sync, buttons, dashboard, inbox: P.inbox, log });

  // Agents → Telegram. Changes are handled in order, one at a time.
  let first = true, queue = Promise.resolve();
  hc.follow((msg) => {
    const changes = herd.apply(msg);
    const isSnapshot = Array.isArray(msg.terminals);
    queue = queue.then(async () => {
      if (state.daemon.status === "error") { state.daemon.status = "running"; state.daemon.error = null; save(); }
      for (const c of changes) await sync.handle(c);
      if (isSnapshot && first) { first = false; await sync.sweep(); }
      if (changes.length || isSnapshot) dashboard.refresh();
    }).catch(err => log(`agents: ${err.message}`));
  }, {
    onDown: (why) => { log(`hc: ${why}`); state.daemon = { ...state.daemon, status: "error", error: `hc: ${why}` }; save(); },
  });

  // Status times on the dashboard move on their own.
  setInterval(() => {
    state.daemon.heartbeat_at = new Date().toISOString();
    save();
    dashboard.refresh();
  }, 30000);

  // Telegram → agents: long polling; the offset survives restarts in the state file.
  let wait = 1000;
  for (;;) {
    let updates;
    try {
      updates = await api.raw("getUpdates", { offset: state.offset, timeout: 50, allowed_updates: ["message", "callback_query", "my_chat_member"] });
      wait = 1000;
    } catch (err) {
      if (err.code === 401) { await fail("bot token was revoked"); await unlink(P.lock).catch(() => {}); process.exit(1); }
      log(`getUpdates: ${err.message}`);
      await sleep(err.code === 429 ? (err.retryAfter ?? 5) * 1000 : wait);
      wait = Math.min(wait * 2, 60000);
      continue;
    }
    for (const u of updates) {
      state.offset = u.update_id + 1;
      save();
      try { await commands.handle(u); } catch (err) { log(`update ${u.update_id}: ${err.message}`); }
    }
  }
}

if (process.argv.includes("--check")) check();
else run().catch(err => { log(err.stack ?? err.message); process.exit(1); });
