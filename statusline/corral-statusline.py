#!/usr/bin/env python3
"""Claude Code statusLine hook for Corral, the Herdr agent board.

Prints one line: model | context | cost | [folder]. Saves the statusline JSON
of this session to ~/.cache/corral/sessions/<claude pid>.json, so the
corral mod can show the session id, limits and the rest on the session's card.

With CORRAL_STATUSLINE_CHAIN set to a shell command (your own status line),
that command gets the same stdin and its output is printed instead of Corral's
line. If it fails, times out or prints nothing, Corral's line is printed.
"""
import io
import json
import os
import pathlib
import signal
import subprocess
import sys
import time

sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8", newline="")

SESSIONS_DIR = pathlib.Path.home() / ".cache" / "corral" / "sessions"
MAX_PARENT_HOPS = 8
STALE_SECONDS = 7 * 86400
CHAIN_ENV = "CORRAL_STATUSLINE_CHAIN"
CHAIN_TIMEOUT = 2

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


def chained(raw: str):
    """The output of the CORRAL_STATUSLINE_CHAIN command for this stdin, or None."""
    command = os.environ.get(CHAIN_ENV, "").strip()
    if not command:
        return None
    # The chained command does not see the variable, so it can't call this hook again.
    env = {k: v for k, v in os.environ.items() if k != CHAIN_ENV}
    try:
        # Its own process group: on a timeout its children are killed too, and no pipe stays open.
        proc = subprocess.Popen(
            command,
            shell=True,
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL,
            env=env,
            start_new_session=True,
        )
    except Exception:
        return None
    try:
        out, _ = proc.communicate(raw.encode("utf-8"), timeout=CHAIN_TIMEOUT)
    except Exception:
        try:
            os.killpg(proc.pid, signal.SIGKILL)
        except OSError:
            pass
        proc.wait()
        return None
    if proc.returncode != 0 or not out.strip():
        return None
    return out.decode("utf-8", errors="replace")


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
    raw = sys.stdin.read()
    theirs = chained(raw)
    try:
        data = json.loads(raw or "{}")
    except Exception:
        if theirs is not None:
            sys.stdout.write(theirs)
        return
    sys.stdout.write(render(data) if theirs is None else theirs)
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
