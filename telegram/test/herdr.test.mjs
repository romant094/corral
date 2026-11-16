import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { EventEmitter } from "node:events";
import { makeHerd, makeHc } from "../herdr.mjs";

const lines = readFileSync(new URL("./fixtures/events.jsonl", import.meta.url), "utf8").trim().split("\n").map(l => JSON.parse(l));

const kinds = (changes) => changes.map(c => `${c.kind}:${c.agent.address}${c.kind === "state" ? `:${c.agent.state}` : ""}`);

test("snapshot: only top-level Claude terminals are agents", () => {
  const herd = makeHerd(() => 0);
  assert.deepEqual(kinds(herd.apply(lines[0])), ["added:t1"]);
  assert.deepEqual(herd.list().map(a => a.address), ["t1"]);
  assert.equal(herd.get("t1").where, "gmail / Claude Code");
  assert.equal(herd.get("t1").cwd, "/p/gmail-now");
  assert.equal(herd.get("t3"), null);
});

test("events: start, status changes, where, end", () => {
  const herd = makeHerd(() => 0);
  herd.apply(lines[0]);
  const all = lines.slice(1).map(l => kinds(herd.apply(l)));
  assert.deepEqual(all, [
    [],                  // created, status null
    [],                  // foreground claude
    [],                  // title
    ["added:t4"],        // status claude-code idle
    ["where:t4"],        // labels
    ["state:t4:working"],
    ["state:t4:done"],
    [],                  // turn
    [],                  // status null while claude is still foreground
    ["ended:t4"],        // finished
    [],                  // removed: already ended
    [],                  // t1 status null, claude still foreground
    ["ended:t1"],        // t1 foreground zsh: Claude exited, the shell stays
  ]);
  assert.deepEqual(herd.list(), []);
});

test("ended change carries the last known where", () => {
  const herd = makeHerd(() => 0);
  herd.apply(lines[0]);
  for (const l of lines.slice(1, 9)) herd.apply(l);
  const [end] = herd.apply(lines[10]);
  assert.equal(end.agent.where, "notes / 2");
});

test("a fresh snapshot ends agents that vanished", () => {
  const herd = makeHerd(() => 0);
  herd.apply(lines[0]);
  assert.deepEqual(kinds(herd.apply({ channel: null, seq: 99, terminals: [] })), ["ended:t1"]);
});

// A fake child process: emits the given stdout, then closes with the code.
function fakeSpawn(record, { stdout = "", code = 0 } = {}) {
  return (bin, args, opts) => {
    record.push({ bin, args, env: opts.env });
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.stdin = { write() {}, end() {} };
    child.kill = () => {};
    setImmediate(() => { child.stdout.emit("data", stdout); child.emit("close", code); });
    return child;
  };
}

test("hc calls pass text as one argv element and drop HC_TERMINAL_ID", async () => {
  process.env.HC_TERMINAL_ID = "t9";
  const rec = [];
  const hc = makeHc({ bin: "hc", spawnImpl: fakeSpawn(rec, { stdout: '{"status":"idle"}' }) });
  await hc.send("t1", "hello; rm -rf / $(x)");
  assert.deepEqual(rec[0].args, ["send", "--json", "t1", "--", "hello; rm -rf / $(x)"]);
  await hc.send("t1", "- a bullet, not a flag");
  assert.deepEqual(rec[1].args.slice(-2), ["--", "- a bullet, not a flag"]);
  assert.equal(rec[0].env.HC_TERMINAL_ID, undefined);
  delete process.env.HC_TERMINAL_ID;
});

test("hc errors surface hc's message", async () => {
  const hc = makeHc({ spawnImpl: fakeSpawn([], { stdout: '{"error":{"message":"no terminal t7"}}', code: 1 }) });
  await assert.rejects(hc.get("t7"), /no terminal t7/);
});

test("startClaude labels a fresh tab in the space", async () => {
  const rec = [];
  const hc = makeHc({ spawnImpl: fakeSpawn(rec, { stdout: '{"address":"t5"}' }) });
  await hc.startClaude({ id: "spX", folder: "/p/x" });
  const a = rec[0].args;
  assert.deepEqual(a.slice(0, 5), ["run", "--json", "--bg", "--no-parent", "--cwd=/p/x"]);
  assert.ok(a.includes("herdr.space=spX"));
  assert.ok(a.some(x => /^herdr\.tab=tb[0-9a-f]{32}$/.test(x)));
  assert.equal(a.at(-1), "claude");
});
