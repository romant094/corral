import { test } from "node:test";
import assert from "node:assert/strict";
import { makeApi, TelegramError, splitText, escapeHtml, topicLink } from "../telegram.mjs";

const TOKEN = "123:SECRETSECRETSECRETSECRET";

const reply = (body, status = 200) => ({ status, ok: status < 400, json: async () => body });

test("call posts JSON to the method and returns result", async () => {
  const seen = [];
  const api = makeApi(TOKEN, {
    fetchImpl: async (url, init) => { seen.push({ url, init }); return reply({ ok: true, result: { id: 1 } }); },
  });
  assert.deepEqual(await api.call("getMe"), { id: 1 });
  assert.equal(seen[0].url, `https://api.telegram.org/bot${TOKEN}/getMe`);
  assert.equal(seen[0].init.method, "POST");
});

test("errors never carry the token", async () => {
  const api = makeApi(TOKEN, { fetchImpl: async () => reply({ ok: false, error_code: 401, description: "Unauthorized" }, 401) });
  await assert.rejects(api.call("getMe"), (err) => {
    assert.ok(err instanceof TelegramError);
    assert.equal(err.code, 401);
    assert.ok(!err.message.includes("SECRET"));
    return true;
  });
});

test("429 is retried after retry_after; 400 is not retried", async () => {
  let calls = 0;
  const api = makeApi(TOKEN, {
    fetchImpl: async () => {
      calls++;
      return calls === 1
        ? reply({ ok: false, error_code: 429, description: "Too Many Requests", parameters: { retry_after: 0 } }, 429)
        : reply({ ok: true, result: true });
    },
  });
  assert.equal(await api.call("sendMessage", {}), true);
  assert.equal(calls, 2);

  calls = 0;
  const bad = makeApi(TOKEN, { fetchImpl: async () => { calls++; return reply({ ok: false, error_code: 400, description: "Bad Request" }, 400); } });
  await assert.rejects(bad.call("sendMessage", {}));
  assert.equal(calls, 1);
});

test("network errors become TelegramError with code null", async () => {
  const api = makeApi(TOKEN, { fetchImpl: async () => { throw new TypeError("fetch failed"); } });
  await assert.rejects(api.call("getMe", {}, { tries: 1 }), (err) => err.code === null);
});

test("splitText keeps lines whole and respects the limit", () => {
  assert.deepEqual(splitText("short"), ["short"]);
  assert.deepEqual(splitText(""), [""]);
  const text = ["a".repeat(6), "b".repeat(6), "c".repeat(6)].join("\n");
  assert.deepEqual(splitText(text, 13), ["aaaaaa\nbbbbbb", "cccccc"]);
  const long = splitText("x".repeat(25), 10);
  assert.deepEqual(long, ["x".repeat(10), "x".repeat(10), "x".repeat(5)]);
  for (const c of splitText(Array.from({ length: 500 }, (_, i) => `line ${i}`).join("\n"), 100)) assert.ok(c.length <= 100);
});

test("escapeHtml and topicLink", () => {
  assert.equal(escapeHtml("<a & b>"), "&lt;a &amp; b&gt;");
  assert.equal(topicLink(-1001234567890, 42), "https://t.me/c/1234567890/42");
});
