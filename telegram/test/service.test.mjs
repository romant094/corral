import { test } from "node:test";
import assert from "node:assert/strict";
import { makeService, plistText, LABEL } from "../service.mjs";

function world({ loaded = false, running = true } = {}) {
  const calls = [], files = {};
  let isLoaded = loaded;
  const run = async (cmd, args) => {
    calls.push([cmd, ...args].join(" "));
    const [verb] = args;
    if (verb === "print") return isLoaded
      ? { code: 0, stdout: `${LABEL} = {\n\tstate = ${running ? "running" : "waiting"}\n\tpid = 4242\n}`, stderr: "" }
      : { code: 113, stdout: "", stderr: "Could not find service" };
    if (verb === "bootstrap") isLoaded = true;
    if (verb === "bootout") isLoaded = false;
    return { code: 0, stdout: "", stderr: "" };
  };
  const fs = {
    readFile: async (p) => { if (!(p in files)) throw new Error("ENOENT"); return files[p]; },
    writeFile: async (p, t) => { files[p] = t; },
    unlink: async (p) => { delete files[p]; },
    mkdir: async () => {},
  };
  const service = makeService({ run, fs, uid: 501, home: "/Users/a", node: "/n/node", bridge: "/b/bridge.mjs", log: "/l/telegram.log",
    env: { PATH: "/usr/bin:/opt/hc", HERDR_APP_HOME: "" }, platform: "darwin" });
  return { service, calls, files };
}

const PLIST = `/Users/a/Library/LaunchAgents/${LABEL}.plist`;

test("plist: absolute node and bridge, PATH, log, restart only after a crash", () => {
  const text = plistText({ node: "/n/node", bridge: "/b/a&b.mjs", log: "/l/x.log", env: { PATH: ".:/usr/bin::rel/bin", HERDR_APP_HOME: "" } });
  assert.match(text, /<key>WorkingDirectory<\/key><string>\/b<\/string>/);
  assert.match(text, /<string>\/n\/node<\/string>\s*<string>\/b\/a&amp;b.mjs<\/string>/);
  assert.match(text, /<key>PATH<\/key><string>\/usr\/bin<\/string>/);
  assert.doesNotMatch(text, /HERDR_APP_HOME/);
  assert.match(text, /<key>SuccessfulExit<\/key><false\/>/);
  assert.match(text, /<key>ThrottleInterval<\/key><integer>10<\/integer>/);
  assert.match(text, /<key>StandardErrorPath<\/key><string>\/l\/x.log<\/string>/);
});

test("start writes the plist, enables and bootstraps; status reads launchctl print", async () => {
  const { service, calls, files } = world();
  const out = await service("start");
  assert.ok(files[PLIST].includes("/b/bridge.mjs"));
  assert.deepEqual(calls.filter(c => !c.includes(" print ")), [
    `launchctl enable gui/501/${LABEL}`,
    `launchctl bootstrap gui/501 ${PLIST}`,
  ]);
  assert.deepEqual(out, { installed: true, loaded: true, running: true, pid: 4242 });
});

test("start reloads a loaded agent whose plist changed", async () => {
  const { service, calls } = world({ loaded: true });
  await service("start");
  assert.ok(calls.indexOf(`launchctl bootout gui/501/${LABEL}`) < calls.indexOf(`launchctl bootstrap gui/501 ${PLIST}`));
});

test("start on a loaded agent kickstarts it; restart uses -k", async () => {
  const { service, calls } = world({ loaded: true });
  await service("start");
  calls.length = 0;
  await service("start");
  await service("restart");
  assert.ok(calls.includes(`launchctl kickstart gui/501/${LABEL}`));
  assert.ok(calls.includes(`launchctl kickstart -k gui/501/${LABEL}`));
});

test("stop boots out and disables, so a reboot does not start it", async () => {
  const { service, calls } = world({ loaded: true });
  const out = await service("stop");
  assert.ok(calls.includes(`launchctl bootout gui/501/${LABEL}`));
  assert.ok(calls.includes(`launchctl disable gui/501/${LABEL}`));
  assert.equal(out.running, false);
});

test("uninstall removes the plist", async () => {
  const { service, files } = world();
  await service("start");
  const out = await service("uninstall");
  assert.equal(PLIST in files, false);
  assert.deepEqual(out, { installed: false, loaded: false, running: false, pid: null });
});

test("other systems and unknown verbs are refused", async () => {
  const off = makeService({ run: async () => ({}), uid: 1, home: "/", node: "n", bridge: "b", log: "l", env: {}, platform: "linux" });
  await assert.rejects(off("start"), /needs macOS/);
  const { service } = world();
  await assert.rejects(service("reload"), /unknown service verb/);
});
