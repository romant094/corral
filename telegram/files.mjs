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

// Returns the reply to post in the topic.
export async function handleFile({ msg, agent, api, hc, inbox, now = Date.now() }) {
  const file = fileOf(msg);
  if (!file) return null;
  if (file.size > MAX_BYTES) return "⚠️ Files over 20 MB cannot be received by a bot.";
  if (agent.state === "blocked") return "⚠️ The agent is waiting at a dialog. Answer it first, then send the file again.";
  const { bytes } = await api.download(file.id);
  const local = inboxPath(inbox, agent.address, file.name, now);
  // Screenshots and documents are private: owner-only, like the rest of the bridge's files.
  await mkdir(join(local, ".."), { recursive: true, mode: 0o700 });
  await writeFile(local, bytes, { mode: 0o600 });
  const put = await hc.put(agent.address, local);
  const prompt = [msg.caption?.trim(), put.path ?? local].filter(Boolean).join(" ");
  await hc.send(agent.address, prompt);
  return null;
}
