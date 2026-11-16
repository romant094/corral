// herdr-core through the hc CLI. Every call is spawn(hc, argv): chat text is an
// argv element and never meets a shell.
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";

// Inside a terminal hc tags what it types as <hc from="tN">…</hc>. The bridge
// types for the user, so it runs hc as if from nowhere.
function hcEnv(env = process.env) {
  const { HC_TERMINAL_ID, ...rest } = env;
  return rest;
}

export function makeHc({ bin = process.env.HC_BIN || "hc", spawnImpl = spawn, timeout = 15000 } = {}) {
  function run(args, { input } = {}) {
    return new Promise((resolve) => {
      let out = "", err = "", done = false;
      let child;
      try {
        child = spawnImpl(bin, args, { env: hcEnv(), stdio: ["pipe", "pipe", "pipe"] });
      } catch (e) {
        resolve({ code: -1, stdout: "", stderr: String(e?.message ?? e) });
        return;
      }
      const finish = (code) => { if (!done) { done = true; clearTimeout(timer); resolve({ code, stdout: out, stderr: err }); } };
      const timer = setTimeout(() => { child.kill(); err ||= `hc ${args[0]} timed out`; finish(-1); }, timeout);
      child.stdout.on("data", (d) => { out += d; });
      child.stderr.on("data", (d) => { err += d; });
      child.on("error", (e) => { err = e.code === "ENOENT" ? `${bin} not found` : String(e.message); finish(-1); });
      child.on("close", (code) => finish(code));
      if (input !== undefined) child.stdin.write(input);
      child.stdin.end();
    });
  }

  // A JSON answer, or an Error with hc's own message.
  async function json(args) {
    const r = await run([...args, "--json"]);
    let body;
    try { body = JSON.parse(r.stdout); } catch { body = undefined; }
    if (r.code !== 0 || body === undefined || body?.error) {
      throw new Error(body?.error?.message || r.stderr.trim() || `hc ${args[0]} failed (${r.code})`);
    }
    return body;
  }

  // One JSON-RPC call over `hc connect`, for methods with no CLI verb (doc.get).
  // Our side stays open until the answer is in: closing first can lose it.
  function rpc(method, params = {}) {
    return new Promise((resolve, reject) => {
      const child = spawnImpl(bin, ["connect"], { env: hcEnv(), stdio: ["pipe", "pipe", "ignore"] });
      let buf = "", settled = false;
      const finish = (e, v) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        child.stdin.end();
        child.kill();
        e ? reject(e) : resolve(v);
      };
      const timer = setTimeout(() => finish(new Error(`${method}: no answer from hc`)), timeout);
      child.on("error", (e) => finish(e));
      child.on("close", () => finish(new Error(`${method}: hc connect ended`)));
      child.stdout.on("data", (d) => {
        buf += d;
        let at;
        while ((at = buf.indexOf("\n")) >= 0) {
          const line = buf.slice(0, at);
          buf = buf.slice(at + 1);
          let msg;
          try { msg = JSON.parse(line); } catch { continue; }
          if (msg.id !== 1) continue;
          if (msg.error) finish(new Error(`${method}: ${msg.error.message ?? "failed"}`));
          else finish(null, msg.result);
        }
      });
      child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 1, method, params })}\n`);
    });
  }

  // `hc events --json`, one parsed line at a time. Restarts 5 s after hc exits;
  // the first line after a (re)start is always a full snapshot.
  function follow(onLine, { onDown = () => {}, delay = 5000 } = {}) {
    let stopped = false, child = null, timer = null;
    const start = () => {
      if (stopped) return;
      let buf = "";
      child = spawnImpl(bin, ["events", "--json"], { env: hcEnv(), stdio: ["ignore", "pipe", "pipe"] });
      let err = "";
      child.stderr?.on("data", (d) => { err += d; });
      child.stdout.on("data", (d) => {
        buf += d;
        let at;
        while ((at = buf.indexOf("\n")) >= 0) {
          const line = buf.slice(0, at);
          buf = buf.slice(at + 1);
          if (!line.trim()) continue;
          let msg;
          try { msg = JSON.parse(line); } catch { continue; }
          onLine(msg);
        }
      });
      const again = (why) => {
        if (stopped || !child) return;
        child = null;
        onDown(why);
        timer = setTimeout(start, delay);
      };
      child.on("error", (e) => again(e.code === "ENOENT" ? `${bin} not found` : e.message));
      child.on("close", (code) => again(err.trim() || `hc events ended (${code})`));
    };
    start();
    return () => { stopped = true; clearTimeout(timer); child?.kill(); };
  }

  return {
    run, json, rpc, follow,
    ls: () => json(["ls"]),
    get: (t) => json(["get", t]),
    send: (t, text) => json(["send", t, text]),
    keys: (t, ...keys) => json(["keys", t, ...keys]),
    kill: (t) => json(["kill", t]),
    rm: (t) => json(["rm", t]),
    put: (t, file) => json(["put", t, file]),
    read: async (t, lines = 0) => (await json(["read", t, "--lines", String(lines)])).text ?? "",
    spaces: async () => {
      const r = await rpc("doc.get", { name: "herdr-app" });
      return Array.isArray(r?.value?.spaces) ? r.value.spaces : [];
    },
    // Herdr.app adopts a terminal labelled with a tab id it has not seen as a
    // new tab of that space (verified, see SPEC-tg-bridge.md).
    startClaude: (space) => json([
      "run", "--bg", "--no-parent", "--cwd", space.folder,
      "--label", `herdr.space=${space.id}`, "--label", `herdr.tab=tb${randomBytes(16).toString("hex")}`,
      "claude",
    ]),
  };
}

// ---------------------------------------------------------------- the herd

// What the bridge keeps of a terminal: enough to tell an agent and its topic name.
function pick(t) {
  return {
    address: t.address,
    parent: t.parent ?? null,
    live: t.state === "live",
    status: t.status ?? null,
    fg: t.foreground?.name ?? null,
    pid: t.foreground?.pid ?? t.pid ?? null,
    // The terminal's cwd is where its shell started; Claude's own is the foreground's.
    cwd: t.foreground?.cwd ?? t.cwd ?? "",
    where: t.labels?.where ?? "",
    since: t.status_ms ?? Date.now(),
  };
}

// A Claude Code agent: a live top-level terminal whose status says claude-code.
// While Claude is still in the foreground a null status keeps it one: the
// status can drop before the foreground changes when Claude exits.
function isAgent(t, was) {
  if (!t.live || t.parent) return false;
  if (t.status?.app === "claude-code") return true;
  return was && t.status === null && t.fg === "claude";
}

const stateOf = (t) => t.status?.state ?? "idle";

export function agentView(t) {
  return { address: t.address, state: stateOf(t), where: t.where || t.address, cwd: t.cwd, pid: t.pid, since: t.since };
}

// Terminals by address, and which of them are agents. `apply` takes one line of
// `hc events --json` and returns the agent changes it caused:
//   { kind: "added" | "state" | "where" | "ended", agent }
export function makeHerd(now = () => Date.now()) {
  const terms = new Map();
  const agents = new Set();

  function diff(before) {
    const changes = [];
    for (const [address, t] of terms) {
      const was = agents.has(address);
      const is = isAgent(t, was);
      const prev = before.get(address);
      if (is && !was) { agents.add(address); changes.push({ kind: "added", agent: agentView(t) }); }
      else if (!is && was) { agents.delete(address); changes.push({ kind: "ended", agent: agentView(prev ?? t) }); }
      else if (is && prev) {
        if (stateOf(prev) !== stateOf(t) && t.status) changes.push({ kind: "state", agent: agentView(t), from: stateOf(prev) });
        if (prev.where !== t.where) changes.push({ kind: "where", agent: agentView(t) });
      }
    }
    for (const address of [...agents]) {
      if (!terms.has(address)) {
        agents.delete(address);
        changes.push({ kind: "ended", agent: agentView(before.get(address)) });
      }
    }
    return changes;
  }

  function snapshot(list) {
    const before = new Map(terms);
    terms.clear();
    for (const t of list) terms.set(t.address, pick(t));
    return diff(before);
  }

  function apply(msg) {
    if (Array.isArray(msg?.terminals)) return snapshot(msg.terminals);
    const p = msg?.params;
    if (msg?.method !== "event" || !p) return [];
    if (p.type === "missed" && Array.isArray(p.data?.terminals)) return snapshot(p.data.terminals);
    const before = new Map([...terms].map(([k, v]) => [k, { ...v }]));
    const t = terms.get(p.terminal);
    const d = p.data ?? {};
    switch (p.type) {
      case "created": terms.set(d.address ?? p.terminal, pick({ ...d, address: d.address ?? p.terminal })); break;
      case "status": if (t) { t.status = d.status ?? null; t.since = now(); } break;
      case "foreground": if (t) { t.fg = d.name ?? null; t.pid = d.pid ?? t.pid; t.cwd = d.cwd ?? t.cwd; } break;
      case "labels": if (t) t.where = d.labels?.where ?? t.where; break;
      case "finished": if (t) t.live = false; break;
      case "removed": terms.delete(p.terminal); break;
      default: return [];
    }
    return diff(before);
  }

  const list = () => [...agents].map(a => agentView(terms.get(a)));
  const get = (address) => (agents.has(address) ? agentView(terms.get(address)) : null);
  return { apply, list, get };
}
