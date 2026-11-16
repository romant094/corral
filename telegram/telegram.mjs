// Telegram Bot API over fetch. The token never reaches an error or a log line:
// errors carry the method and Telegram's description only.

export class TelegramError extends Error {
  constructor(method, code, description, retryAfter) {
    super(`${method}: ${code ?? "network"} ${description ?? ""}`.trim());
    this.method = method;
    this.code = code;
    this.retryAfter = retryAfter;
  }
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// One call, no retry. `fetchImpl` is injected so tests never touch the network.
export function makeApi(token, { fetchImpl = fetch, base = "https://api.telegram.org" } = {}) {
  async function raw(method, params = {}) {
    let res;
    try {
      res = await fetchImpl(`${base}/bot${token}/${method}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(params),
        // A hung request must not stall a loop; long polling waits its own timeout plus a margin.
        signal: AbortSignal.timeout(((params.timeout ?? 0) + 30) * 1000),
      });
    } catch (err) {
      throw new TelegramError(method, null, err?.cause?.code ?? err?.name ?? "fetch failed");
    }
    let body;
    try {
      body = await res.json();
    } catch {
      throw new TelegramError(method, res.status, "not JSON");
    }
    if (!body.ok) throw new TelegramError(method, body.error_code ?? res.status, body.description, body.parameters?.retry_after);
    return body.result;
  }

  // Retries what can pass on a second try: 429 after its retry_after, network
  // errors and 5xx with backoff. Other 4xx are the caller's problem.
  async function call(method, params, { tries = 5 } = {}) {
    let wait = 1000;
    for (let i = 1; ; i++) {
      try {
        return await raw(method, params);
      } catch (err) {
        const retryable = err.code === 429 || err.code === null || err.code >= 500;
        if (!retryable || i >= tries) throw err;
        await sleep(err.code === 429 ? (err.retryAfter ?? 1) * 1000 : wait);
        wait = Math.min(wait * 2, 60000);
      }
    }
  }

  // Bytes of a file the user sent. getFile gives a path; the file URL carries the token too.
  async function download(fileId) {
    const file = await call("getFile", { file_id: fileId });
    let res, bytes;
    try {
      res = await fetchImpl(`${base}/file/bot${token}/${file.file_path}`, { signal: AbortSignal.timeout(120000) });
      if (res.ok) bytes = new Uint8Array(await res.arrayBuffer());
    } catch (err) {
      // fetch errors can quote the URL, and the URL holds the token.
      throw new TelegramError("download", null, err?.cause?.code ?? err?.name ?? "fetch failed");
    }
    if (!res.ok) throw new TelegramError("download", res.status, "file download failed");
    return { bytes, path: file.file_path };
  }

  return { raw, call, download };
}

// Telegram counts message length in UTF-16 units, as JS strings do. Splits on
// line ends under the limit, so a chunk never cuts a line in half unless the
// line alone is longer.
export function splitText(text, limit = 3500) {
  const chunks = [];
  let cur = "";
  for (const line of text.split("\n")) {
    let rest = line;
    while (rest.length > limit) {
      if (cur) { chunks.push(cur); cur = ""; }
      chunks.push(rest.slice(0, limit));
      rest = rest.slice(limit);
    }
    const next = cur ? `${cur}\n${rest}` : rest;
    if (next.length > limit) { chunks.push(cur); cur = rest; }
    else cur = next;
  }
  if (cur || chunks.length === 0) chunks.push(cur);
  return chunks;
}

export const escapeHtml = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

// A link to a topic of a supergroup: t.me/c/<id without -100>/<topic>.
export function topicLink(chatId, topicId) {
  const internal = String(chatId).replace(/^-100/, "");
  return `https://t.me/c/${internal}/${topicId}`;
}
