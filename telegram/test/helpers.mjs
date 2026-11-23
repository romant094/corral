// Fakes shared by the tests: a Bot API that records calls, an hc that records
// calls, and a herd fed with terminal snapshots.
import { emptyState, makeRegistry } from "../config.mjs";
import { makeHerd } from "../herdr.mjs";
import { makeButtons } from "../buttons.mjs";

export const settings = { token: "1:x", chat_id: -1001, root_topic_id: null, owner_ids: [7] };

export function fakeApi() {
  const calls = [];
  let topic = 100, msg = 500;
  const call = async (method, params) => {
    calls.push({ method, params });
    if (method === "createForumTopic") return { message_thread_id: ++topic, name: params.name };
    if (method === "sendMessage") return { message_id: ++msg };
    return true;
  };
  return {
    calls, call, raw: call,
    download: async () => ({ bytes: new Uint8Array([1, 2, 3]), path: "photos/x.jpg" }),
    of: (m) => calls.filter(c => c.method === m),
  };
}

export function fakeHc(screen = "") {
  const calls = [];
  const rec = (name) => async (...args) => { calls.push([name, ...args]); return {}; };
  return {
    calls,
    screen,
    send: rec("send"), keys: rec("keys"), kill: rec("kill"), rm: rec("rm"),
    put: async (t, f) => { calls.push(["put", t, f]); return { path: `/core/files/${t}/x` }; },
    read: async (t) => { calls.push(["read", t]); return screen; },
    spaces: async () => [
      { id: "spA", name: "gmail", folder: "/p/gmail", tabs: [
        { id: "tbA1", root: { children: [{ content: { terminal: "tX" } }] } },
        { id: "tbA2", root: { children: [{ content: { terminal: "t1" } }] } },
      ] },
      { id: "spB", name: "notes", folder: "/p/notes", tabs: [] },
    ],
    startClaude: async (...args) => { calls.push(["startClaude", ...args]); return { address: `t9${calls.length}` }; },
  };
}

export const term = (address, state = "idle", extra = {}) => ({
  address, parent: null, state: "live", cwd: `/p/${address}`, pid: 1,
  foreground: { name: "claude", pid: 1 }, labels: { where: `${address} / 1` },
  status: { app: "claude-code", state }, status_ms: 0, ...extra,
});

export function world({ terminals = [], screen = "", reply = null } = {}) {
  const api = fakeApi();
  const hc = fakeHc(screen);
  const herd = makeHerd(() => 0);
  const state = emptyState();
  const buttons = makeButtons();
  const logs = [];
  const base = { api, hc, herd, state, buttons, settings, registry: makeRegistry(), save: () => {}, log: (m) => logs.push(m), lastReply: async () => reply };
  herd.apply({ terminals });
  return { ...base, logs };
}

export const status = (address, s) => ({ method: "event", params: { type: "status", terminal: address, data: { status: s && { app: "claude-code", state: s } } } });
