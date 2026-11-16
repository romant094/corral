// The agent's last reply, from its Claude Code transcript. The Corral statusline
// hook saves each session's statusline JSON under ~/.cache/corral/sessions/<pid>.json;
// it names the transcript.
import { open, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

export const sessionsDir = (env = process.env) => join(env.HOME || homedir(), ".cache", "corral", "sessions");

// Transcripts grow to megabytes; the last reply is near the end.
async function readTail(file, bytes = 2 * 1024 * 1024) {
  const fh = await open(file, "r");
  try {
    const { size } = await fh.stat();
    const start = Math.max(0, size - bytes);
    const buf = Buffer.alloc(size - start);
    await fh.read(buf, 0, buf.length, start);
    const text = buf.toString("utf8");
    return start > 0 ? text.slice(text.indexOf("\n") + 1) : text;
  } finally {
    await fh.close();
  }
}

// Text blocks of the last main-thread assistant line that has text.
export function lastReplyFrom(jsonl) {
  const lines = jsonl.split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    if (!lines[i].includes('"assistant"')) continue;
    let d;
    try { d = JSON.parse(lines[i]); } catch { continue; }
    if (d.type !== "assistant" || d.isSidechain) continue;
    const content = d.message?.content;
    const text = Array.isArray(content)
      ? content.filter(b => b?.type === "text" && b.text?.trim()).map(b => b.text.trim()).join("\n\n")
      : typeof content === "string" ? content.trim() : "";
    if (text) return text;
  }
  return null;
}

export async function lastReply(pid, dir = sessionsDir()) {
  if (!pid) return null;
  try {
    const session = JSON.parse(await readFile(join(dir, `${pid}.json`), "utf8"));
    if (!session.transcript_path) return null;
    return lastReplyFrom(await readTail(session.transcript_path));
  } catch {
    return null;
  }
}
