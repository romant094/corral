// Photos and documents sent to an agent's topic: saved in the inbox, handed to
// the agent's machine with `hc put`, and named in a prompt.
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

export const MAX_BYTES = 20 * 1024 * 1024; // Bot API getFile limit

// Only [A-Za-z0-9._-], no leading dot: a name from Telegram cannot climb out of the inbox.
export function cleanName(name) {
  const clean = String(name ?? "").replace(/[^A-Za-z0-9._-]/g, "_").replace(/^\.+/, "_").slice(-80);
  return clean && !/^[_.]*$/.test(clean) ? clean : "file";
}

export function inboxPath(inbox, address, name, now = Date.now()) {
  const stamp = new Date(now).toISOString().replace(/[-:]/g, "").replace(/\..*/, "");
  return join(inbox, cleanName(address), `${stamp}-${cleanName(name)}`);
}

// The file a message carries: the largest photo size, or the document.
export function fileOf(msg) {
  if (Array.isArray(msg.photo) && msg.photo.length) {
    const p = msg.photo.at(-1);
    return { id: p.file_id, size: p.file_size ?? 0, name: "photo.jpg" };
  }
  if (msg.document) return { id: msg.document.file_id, size: msg.document.file_size ?? 0, name: msg.document.file_name ?? "file" };
  return null;
}

// Saves the file in the inbox and hands it to the agent's machine; returns the path the agent sees.
export async function deliverFile({ file, agent, api, hc, inbox, now = Date.now() }) {
  const { bytes } = await api.download(file.id);
  const local = inboxPath(inbox, agent.address, file.name, now);
  // Screenshots and documents are private: owner-only, like the rest of the bridge's files.
  await mkdir(join(local, ".."), { recursive: true, mode: 0o700 });
  await writeFile(local, bytes, { mode: 0o600 });
  const put = await hc.put(agent.address, local);
  return put.path ?? local;
}

// Returns the reply to post in the topic. `quote`: the reply line to put first (see replyContext).
export async function handleFile({ msg, agent, api, hc, inbox, now = Date.now(), quote = null }) {
  const file = fileOf(msg);
  if (!file) return null;
  if (file.size > MAX_BYTES) return "⚠️ Files over 20 MB cannot be received by a bot.";
  if (agent.state === "blocked") return "⚠️ The agent is waiting at a dialog. Answer it first, then send the file again.";
  const path = await deliverFile({ file, agent, api, hc, inbox, now });
  const prompt = [msg.caption?.trim(), path].filter(Boolean).join(" ");
  await hc.send(agent.address, quote ? `${quote}\n${prompt}` : prompt);
  return null;
}

// A message that answers another one. Every message in a topic answers the
// topic's first one; that is not a reply.
export function repliedTo(msg) {
  const r = msg.reply_to_message;
  if (!r || r.forum_topic_created || r.message_id === msg.message_thread_id) return null;
  return r;
}

// The line the agent gets before such a message: whose message it answers, its
// text (or the quoted part), and its file when it had one (`filePath`, delivered by the caller).
export function replyContext(msg, filePath = null) {
  const r = repliedTo(msg);
  if (!r) return null;
  const name = [r.from?.first_name, r.from?.last_name].filter(Boolean).join(" ") || "someone";
  const who = r.from?.is_bot ? "your earlier message" : `${name}'s message`;
  let text = String(msg.quote?.text ?? r.text ?? r.caption ?? "").replace(/\s+/g, " ").trim();
  if (text.length > 300) text = `${text.slice(0, 300)}…`;
  const parts = [text && `"${text}"`, filePath && `(with file ${filePath})`].filter(Boolean);
  return `[In reply to ${who}${parts.length ? `: ${parts.join(" ")}` : ""}]`;
}
