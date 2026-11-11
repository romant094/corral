#!/usr/bin/env python3
"""Claude Code statusLine hook for Corral, the Herdr agent board.

Prints one line: model | context | cost | [folder]. Saves the statusline JSON
of this session to ~/.cache/corral/sessions/<claude pid>.json, so the
corral mod can show the session id, limits and the rest on the session's card.
"""
import io
import json
import os
import pathlib
import subprocess
import sys
import time

sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8", newline="")

SESSIONS_DIR = pathlib.Path.home() / ".cache" / "corral" / "sessions"
MAX_PARENT_HOPS = 8
STALE_SECONDS = 7 * 86400

RESET = "\x1b[0m"
DIM = "\x1b[90m"
GREEN = "\x1b[32m"
YELLOW = "\x1b[33m"
RED = "\x1b[31m"
CYAN = "\x1b[36m"
SEP = f"{DIM} | {RESET}"


def color_by_pct(pct: float) -> str:
    if pct < 50:
        return GREEN
    if pct < 80:
        return YELLOW
    return RED


def render(data: dict) -> str:
    segments = []
    model = (data.get("model") or {}).get("display_name") or ""
    if model:
        segments.append(f"{GREEN}{model}{RESET}")
    ctx_obj = data.get("context_window") or {}
    ctx = ctx_obj.get("used_percentage")
    if ctx is not None:
        try:
            p = float(ctx)
            tokens = ctx_obj.get("total_input_tokens")
            suffix = f" ({round(int(tokens) / 1000)}k)" if tokens is not None else ""
            segments.append(f"{color_by_pct(p)}Context: {int(round(p))}%{suffix}{RESET}")
        except (TypeError, ValueError):
            pass
    cost = (data.get("cost") or {}).get("total_cost_usd")
    if cost is not None:
        try:
            segments.append(f"{DIM}${float(cost):.2f}{RESET}")
        except (TypeError, ValueError):
            pass
    cwd = (data.get("workspace") or {}).get("current_dir") or data.get("cwd") or ""
    if cwd:
        segments.append(f"{CYAN}[{os.path.basename(cwd.rstrip('/')) or cwd}]{RESET}")
    return SEP.join(segments)


def parent_of(pid: int):
    try:
        out = subprocess.run(
            ["ps", "-o", "ppid=,comm=", "-p", str(pid)],
            capture_output=True,
            text=True,
            timeout=2,
        ).stdout.strip()
        ppid, comm = out.split(None, 1)
        return int(ppid), os.path.basename(comm)
    except Exception:
        return None, ""


def claude_pid():
    """The pid of the claude process that runs this hook, or None."""
    pid = os.getppid()
    for _ in range(MAX_PARENT_HOPS):
        if pid is None or pid <= 1:
            return None
        ppid, comm = parent_of(pid)
        if comm == "claude":
            return pid
        pid = ppid
    return None


def remove_stale() -> None:
    now = time.time()
    for path in SESSIONS_DIR.glob("*.json"):
        try:
            if now - path.stat().st_mtime > STALE_SECONDS:
                path.unlink()
        except OSError:
            pass


def main() -> None:
    try:
        data = json.loads(sys.stdin.read() or "{}")
    except Exception:
        return
    sys.stdout.write(render(data))
    sys.stdout.flush()
    pid = claude_pid()
    if pid is None:
        return
    data["herdr_claude_pid"] = pid
    data["herdr_written_at"] = int(time.time())
    try:
        SESSIONS_DIR.mkdir(parents=True, exist_ok=True)
        target = SESSIONS_DIR / f"{pid}.json"
        tmp = target.with_suffix(".json.tmp")
        tmp.write_text(json.dumps(data), encoding="utf-8")
        os.replace(tmp, target)
        remove_stale()
    except OSError:
        pass


if __name__ == "__main__":
    main()
