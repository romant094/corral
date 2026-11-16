# Implementation Plan: tg-bridge

Source spec: [SPEC-tg-bridge.md](../SPEC-tg-bridge.md) (module `tg-bridge` of [CAPABILITY-MAP.md](../CAPABILITY-MAP.md))

## Overview

A Node daemon in `telegram/` that mirrors the live Claude Code agents of
herdr-core into a Telegram forum group: one topic per agent, status in the
topic name, last reply on `done`, the screen and option buttons on `blocked`,
text and files back to the agent, `/new` `/status` `/screen` `/stop` `/close`
`/clear` `/help`. The settings UI is the next module (tg-settings); until then
`telegram.json` is written by hand.

## Architecture Decisions

- **Two loops, one state.** Loop A follows `hc events --json` (agents → Telegram).
  Loop B long-polls `getUpdates` (Telegram → agents). Both change one in-memory
  state object; a debounced writer saves it to `telegram-state.json`.
- **Injected transports.** `telegram.mjs` takes a `call(method, params)`
  function, `herdr.mjs` takes a `run(args)` and a `stream(args)` function.
  Tests pass fakes; the real ones wrap `fetch` and `child_process.spawn`.
- **Pure decision functions.** Event → actions and update → actions are pure
  functions that return a list of actions (`createTopic`, `rename`, `post`,
  `keys`, `send`, …). An executor runs them. Most tests target the pure part.
- **No shell.** Every `hc` call is `spawn(hcBin, argv)`.
- **Throttle per topic.** Renames and dashboard edits wait 10 s and keep the
  last value, so a flapping status does not hit Telegram's rate limits.

## Dependency Graph

```
config.mjs ─┬─ telegram.mjs ─┐
            └─ herdr.mjs ────┼─ agents.mjs (topic sync, posts) ─┬─ commands.mjs (topic input, buttons, root)
                             │                                   │
                             └─────────── bridge.mjs (loops, lock, state writer, --check)
```

## Task List

Detailed tasks with acceptance criteria and verification: [todo.md](todo.md).

### Phase 1: Foundation
- [ ] Task 1: Verify that Herdr.app adopts a labelled `hc run` terminal as a tab
- [ ] Task 2: Config, state file and Bot API client with `--check`
- [ ] Task 3: `hc` wrapper and the agent model from `hc events`

### Checkpoint 1: Foundation
- [ ] `node --test telegram/test/` passes; `--check` is green on this Mac

### Phase 2: Core slices
- [ ] Task 4: A topic per agent with the status in its name
- [ ] Task 5: Text from a topic to its agent, `/screen`, `/stop`
- [ ] Task 6: `done` and `blocked` posts

### Checkpoint 2: Agent topics end to end
- [ ] User stories 2, 3, 4, 5 (text replies), 6 work with a real bot

### Phase 3: Buttons, root topic, files
- [ ] Task 7: Option buttons on `blocked` posts
- [ ] Task 8: `/close`, Delete topic and `/clear`
- [ ] Task 9: Root topic: `/status`, dashboard, `/help`, command menu
- [ ] Task 10: `/new` with space buttons
- [ ] Task 11: Photos and files to the agent

### Checkpoint 3: Feature complete
- [ ] User stories 1–12 work with a real bot

### Phase 4: Delivery
- [ ] Task 12: `install.sh` and README

### Checkpoint 4: Done
- [ ] Spec success criteria 1–7 met; ready for review

## Risks and Mitigations

| Risk | Impact | Mitigation |
|------|--------|------------|
| Herdr.app does not adopt a labelled `hc run` terminal | High (`/new`) | Task 1 runs first. Fallback in the spec: refuse `/new` with a reason, or start through the app when it runs |
| Each `editForumTopic` posts a "topic renamed" service line into the topic | Medium (noise) | 10 s throttle; only real state changes rename; README tells to mute the group if needed |
| Claude Code dialog layout changes and the parser misses options | Medium | Parser is a pure function with fixtures from real screens; without options the post still goes out and text replies work |
| `hc events` format changes between hc versions | Medium | Parse only the fields used; unknown events are ignored and logged once |
| Telegram rate limits (429) | Low | Backoff with `retry_after`; throttled edits |
| Transcript of the session is not found | Low | Fall back to the last 20 screen lines |

## Open Questions

- None blocking. Task 1 answers the one open question of the spec.
