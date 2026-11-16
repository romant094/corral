#!/usr/bin/env node
// Corral's Telegram bridge: Herdr agents ↔ topics of a Telegram forum group.
//   node bridge.mjs           run in the foreground (launchd runs it the same way)
//   node bridge.mjs --check [--json]          check settings, bot, group and hc; sends nothing
//   node bridge.mjs --discover --json         groups, topics and people the bot sees (for Corral's wizard)
//   node bridge.mjs --create-topic <name> --json
import { readFile, writeFile, unlink, mkdir, chmod } from "node:fs/promises";
import { writeFileSync, unlinkSync } from "node:fs";
import { paths, loadSettings, loadState, saveState, trimLog } from "./config.mjs";
import { makeApi } from "./telegram.mjs";
import { makeHc, makeHerd } from "./herdr.mjs";
import { makeSync, loadIcons } from "./agents.mjs";
import { makeButtons } from "./buttons.mjs";
import { makeDashboard } from "./dashboard.mjs";
import { makeCommands, COMMANDS } from "./commands.mjs";
import { lastReply, session } from "./transcript.mjs";
import * as setup from "./setup.mjs";

const log = (...a) => console.error(new Date().toISOString(), ...a);
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const P = paths();

const arg = (name) => { const i = process.argv.indexOf(name); return i >= 0 ? process.argv[i + 1] : undefined; };
const print = (value) => process.stdout.write(JSON.stringify(value) + "\n");

// The settings file holds the token: only its owner reads it, whoever wrote it.
async function draft() {
  const settings = await loadSettings(P.settings, { partial: true });
  await chmod(P.settings, 0o600).catch(() => {});
  return settings;
}

async function daemonRunning() {
  const pid = Number(await readFile(P.lock, "utf8").catch(() => ""));
  try { if (pid) { process.kill(pid, 0); return true; } } catch {}
  return false;
}

// --check: a person reads it; --check --json: the wizard does. Both send nothing to the group.
async function check(json) {
  let settings, result;
  try {
    settings = await draft();
    result = await setup.check({ api: makeApi(settings.token), hc: makeHc(), settings });
  } catch (err) {
    result = { ok: false, bot: null, group: null, rights: null, hc: null, errors: [`settings: ${err.message}`] };
  }
  if (json) { print(result); process.exit(0); }
  const line = (good, what, detail) => console.log(`${good ? "OK  " : "FAIL"} ${what}${detail ? `: ${detail}` : ""}`);
  for (const e of result.errors) line(false, ...e.split(/: (.*)/s));
  if (settings) line(true, "settings", P.settings);
  if (result.hc) line(true, "hc", `${result.hc.agents} Claude agents`);
  if (result.bot) line(true, "bot", `@${result.bot.username}`);
  if (result.group) line(result.group.forum, "group", result.group.title);
  if (result.rights) line(!result.rights.missing.length, "bot rights",
    result.rights.missing.length ? `missing ${result.rights.missing.join(", ")}` : "manage topics, delete, pin");
  if (result.bot) await loadIcons(makeApi(settings.token), (text) => console.log(`     ${text}`));
  process.exit(result.ok ? 0 : 1);
}

// --discover: groups, topics and people the bot can see now. --create-topic <name>: a topic in the set group.
async function wizard(mode) {
  try {
    const settings = await draft();
    const api = makeApi(settings.token);
    const state = await loadState(P.state);
    const running = await daemonRunning();
    if (mode === "discover") {
      // The running daemon keeps the lists itself; a second reader would take its updates.
      if (running) return print({ ok: true, ...setup.listing(state) });
      const { changed, found } = await setup.discover({ api, state });
      if (changed) await saveState(P.state, state);
      return print({ ok: true, ...found });
    }
    const name = arg("--create-topic");
    if (!name) throw new Error("--create-topic needs a name");
    const topic = await setup.createTopic({ api, settings, state, name });
    // The daemon owns the state file while it runs.
    if (!running) await saveState(P.state, state);
    print({ ok: true, topic });
  } catch (err) {
    print({ ok: false, error: err.code === 401 ? "the token was rejected" : err.message });
  }
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
    process.exit(0);
  }
  await writeFile(P.lock, String(process.pid));
}

// launchd starts the bridge again after an exit that is not 0. So a problem only the person can fix (settings,
// a bad token, another bridge) exits 0 with the reason in the state file, and only a crash exits non-zero.
async function run() {
  await trimLog(P.log).catch(() => {});
  await lock();
  const state = await loadState(P.state);
  // Every write goes through one chain: two writes of the same temp file at
  // once could publish broken JSON and lose every agent → topic mapping.
  let saving = Promise.resolve(), saveTimer = null;
  const saveNow = () => (saving = saving.then(() => saveState(P.state, state)).catch(err => log(`save state: ${err.message}`)));
  const save = () => {
    if (saveTimer) return;
    saveTimer = setTimeout(() => { saveTimer = null; saveNow(); }, 300);
  };
  const fail = async (why) => {
    log(why);
    state.daemon = { ...state.daemon, status: "error", error: why };
    await saveNow();
  };

  let settings;
  try {
    settings = await loadSettings(P.settings);
  } catch (err) {
    await fail(err.message);
    await unlink(P.lock).catch(() => {});
    process.exit(0);
  }

  // TG_API_BASE points the bridge at a stand-in server for a smoke test. Only
  // this machine or the real API: the token goes wherever this points.
  const base = process.env.TG_API_BASE;
  if (base && !/^(http:\/\/(127\.0\.0\.1|localhost)(:\d+)?|https:\/\/api\.telegram\.org)\/?$/.test(base)) {
    await fail("TG_API_BASE must be http://127.0.0.1:<port>, http://localhost:<port> or https://api.telegram.org");
    await unlink(P.lock).catch(() => {});
    process.exit(0);
  }
  if (base) log(`using the Bot API at ${base}`);
  const api = makeApi(settings.token, base ? { base: base.replace(/\/$/, "") } : {});
  let me;
  try {
    me = await api.call("getMe");
  } catch (err) {
    // A rejected token waits for the person; no network is worth another try.
    await fail(err.code === 401 ? "bot token was rejected" : `bot: ${err.message}`);
    await unlink(P.lock).catch(() => {});
    process.exit(err.code === 401 ? 0 : 1);
  }

  state.daemon = { pid: process.pid, started_at: new Date().toISOString(), heartbeat_at: new Date().toISOString(), status: "running", error: null, bot: me.username };
  await saveNow();
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
  const herd = makeHerd(Date.now, (address) => !!state.agents[address]);
  const buttons = makeButtons();
  const icons = await loadIcons(api, log);
  const dashboard = makeDashboard({ api, settings, state, save, herd, log });
  const sync = makeSync({ api, hc, settings, state, save, log, buttons, herd, icons, lastReply, session });
  const commands = makeCommands({ api, hc, settings, state, save, herd, sync, buttons, dashboard, inbox: P.inbox, log, bot: me.username, session });

  // Agents → Telegram. Changes are handled in order, one at a time.
  let first = true, queue = Promise.resolve();
  hc.follow((msg) => {
    let changes;
    try { changes = herd.apply(msg); } catch (err) { log(`event: ${err.message}`); return; }
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
      if (err.code === 401) { await fail("bot token was revoked"); await unlink(P.lock).catch(() => {}); process.exit(0); }
      log(`getUpdates: ${err.message}`);
      await sleep(err.code === 429 ? (err.retryAfter ?? 5) * 1000 : wait);
      wait = Math.min(wait * 2, 60000);
      continue;
    }
    for (const u of updates) {
      // Saved before acting: a crash must not replay a prompt or a key press.
      state.offset = u.update_id + 1;
      await saveNow();
      try { await commands.handle(u); } catch (err) { log(`update ${u.update_id}: ${err.message}`); }
    }
  }
}

if (process.argv.includes("--check")) check(process.argv.includes("--json"));
else if (process.argv.includes("--discover")) wizard("discover");
else if (process.argv.includes("--create-topic")) wizard("create-topic");
else run().catch(err => { log(err.stack ?? err.message); process.exit(1); });
