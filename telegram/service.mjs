// The bridge as a launchd agent (macOS): Corral's Start and Stop buttons call these through
// `node bridge.mjs --service <verb>`, so the mod never writes outside its own folder.
// Stop also disables the agent, so a stopped bridge stays stopped after a reboot.
import { readFile, writeFile, unlink, mkdir } from "node:fs/promises";
import { join, dirname } from "node:path";

export const LABEL = "dev.corral.telegram";

const xml = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

// node: the Node that runs this now, which Corral found as v20 or newer; launchd gets no PATH to look it up.
// PATH keeps absolute folders only: a "." or an empty entry would look up hc in launchd's working folder.
export function plistText({ node, bridge, log, env }) {
  const clean = { ...env, PATH: (env.PATH ?? "").split(":").filter(p => p.startsWith("/")).join(":") };
  const vars = Object.entries(clean).filter(([, v]) => v);
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${xml(node)}</string>
    <string>${xml(bridge)}</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict>
${vars.map(([k, v]) => `    <key>${xml(k)}</key><string>${xml(v)}</string>`).join("\n")}
  </dict>
  <key>WorkingDirectory</key><string>${xml(dirname(bridge))}</string>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key>
  <dict>
    <key>SuccessfulExit</key><false/>
  </dict>
  <key>ThrottleInterval</key><integer>10</integer>
  <key>StandardOutPath</key><string>${xml(log)}</string>
  <key>StandardErrorPath</key><string>${xml(log)}</string>
</dict>
</plist>
`;
}

// run(cmd, args) → { code, stdout, stderr }; injected so tests see the launchctl calls.
export function makeService({ run, uid, home, node, bridge, log, env, platform = process.platform, fs = { readFile, writeFile, unlink, mkdir } }) {
  const plist = join(home, "Library", "LaunchAgents", `${LABEL}.plist`);
  const domain = `gui/${uid}`;
  const target = `${domain}/${LABEL}`;
  const launchctl = (...args) => run("launchctl", args);
  const fail = (what, r) => { throw new Error(`${what}: ${(r.stderr || r.stdout).trim() || `launchctl exited ${r.code}`}`); };

  async function installed() {
    return fs.readFile(plist, "utf8").then(() => true, () => false);
  }
  async function loaded() {
    return (await launchctl("print", target)).code === 0;
  }
  async function install() {
    await fs.mkdir(dirname(plist), { recursive: true });
    await fs.writeFile(plist, plistText({ node, bridge, log, env }));
    return { plist };
  }
  // A fresh plist each start: a moved Node or an updated bridge path takes effect.
  async function start() {
    await install();
    await launchctl("enable", target);
    if (await loaded()) {
      const r = await launchctl("kickstart", target);
      if (r.code !== 0) fail("start", r);
    } else {
      const r = await launchctl("bootstrap", domain, plist);
      if (r.code !== 0) fail("start", r);
    }
    return status();
  }
  async function stop() {
    if (await loaded()) {
      const r = await launchctl("bootout", target);
      if (r.code !== 0 && await loaded()) fail("stop", r);
    }
    await launchctl("disable", target);
    return status();
  }
  async function restart() {
    if (!(await loaded())) return start();
    const r = await launchctl("kickstart", "-k", target);
    if (r.code !== 0) fail("restart", r);
    return status();
  }
  async function uninstall() {
    await stop();
    await fs.unlink(plist).catch(() => {});
    return status();
  }
  async function status() {
    const r = await launchctl("print", target);
    const pid = Number(/^\s*pid = (\d+)/m.exec(r.stdout)?.[1]) || null;
    return { installed: await installed(), loaded: r.code === 0, running: r.code === 0 && /^\s*state = running/m.test(r.stdout), pid };
  }

  const verbs = { install, start, stop, restart, uninstall, status };
  return async (verb) => {
    if (platform !== "darwin") throw new Error("the service needs macOS (launchd); run `node bridge.mjs` another way here");
    if (!verbs[verb]) throw new Error(`unknown service verb: ${verb} (install, start, stop, restart, uninstall, status)`);
    return verbs[verb]();
  };
}
