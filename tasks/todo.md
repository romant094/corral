# Tasks: tg-bridge

Plan: [plan.md](plan.md). Spec: [SPEC-tg-bridge.md](../SPEC-tg-bridge.md).
Test command for every task: `node --test telegram/test/`.

## Phase 1: Foundation

- [x] **Task 1: Verify that Herdr.app adopts a labelled `hc run` terminal as a tab**
  - Description: Run `hc run --bg --cwd <space folder> --label herdr.space=<id> --label herdr.tab=<new id> claude` against one existing space while Herdr.app runs, and again while it is closed. Record the result in the spec's Facts section, then end the test agent.
  - Acceptance:
    - [ ] The spec says whether the terminal appears as a new tab in that space, with and without the app window
    - [ ] If it does not, the spec names the chosen fallback for `/new`
  - Verify: manual check in Herdr.app; `hc ls` shows the terminal with the labels
  - Dependencies: None
  - Files: `SPEC-tg-bridge.md`
  - Scope: XS

- [x] **Task 2: Config, state file and Bot API client with `--check`**
  - Description: `config.mjs` reads and validates `telegram.json` and reads/writes `telegram-state.json` atomically. `telegram.mjs` wraps Bot API calls with errors that carry no token, and backoff for 429 and network errors. `bridge.mjs --check` validates config, calls `getMe` and `getChat`, runs `hc ls`, and prints one line per check.
  - Acceptance:
    - [ ] Invalid or missing fields in `telegram.json` give a clear error naming the field
    - [ ] State writes are atomic (temp file + rename) and survive a missing file
    - [ ] `--check` prints OK/FAIL for config, token, chat (forum, bot rights), `hc`; sends no message
  - Verify: tests pass; `node telegram/bridge.mjs --check` with a real bot
  - Dependencies: None
  - Files: `telegram/config.mjs`, `telegram/telegram.mjs`, `telegram/bridge.mjs`, `telegram/test/config.test.mjs`, `telegram/test/telegram.test.mjs`
  - Scope: M

- [x] **Task 3: `hc` wrapper and the agent model from `hc events`**
  - Description: `herdr.mjs` runs `hc` subcommands by argv (`ls`, `run`, `send`, `keys`, `read`, `kill`, `put`), streams `hc events --json` with restart on exit, and calls `doc.get herdr-app` through `hc connect`. It turns the snapshot and events into an agent model: live terminals with `status.app == "claude-code"` and no parent, with `state`, `where`, `cwd`, `pid`.
  - Acceptance:
    - [ ] A recorded `hc events` sample yields the expected agents and state changes
    - [ ] Helpers (with a parent) and non-Claude terminals are not agents
    - [ ] The stream restarts after `hc` exits, with a 5 s delay
  - Verify: tests pass with recorded fixtures; a short manual run prints agents of this Mac
  - Dependencies: None
  - Files: `telegram/herdr.mjs`, `telegram/test/herdr.test.mjs`, `telegram/test/fixtures/events.jsonl`
  - Scope: S

### Checkpoint 1: Foundation
- [ ] Tests pass
- [ ] `--check` is green on this Mac
- [ ] Review with the user

## Phase 2: Core slices

- [x] **Task 4: A topic per agent with the status in its name**
  - Description: `agents.mjs` maps agent changes to actions: create a topic `<emoji> <where>` for a new agent, rename on a state change (10 s throttle, last wins), on end rename 🏁, post `Agent ended`, close the topic and move it to `ended`. `bridge.mjs` runs loop A, the lock file, the debounced state writer and the reconcile on start.
  - Acceptance:
    - [ ] A new agent gets one topic within 5 s; a restart of the daemon creates no duplicate
    - [ ] Status changes rename the topic, throttled
    - [ ] An ended agent's topic gets 🏁 and is closed
  - Verify: tests pass; manual: start and end an agent at the desk, watch the group
  - Dependencies: 2, 3
  - Files: `telegram/agents.mjs`, `telegram/bridge.mjs`, `telegram/test/agents.test.mjs`
  - Scope: M

- [x] **Task 5: Text from a topic to its agent, `/screen`, `/stop`**
  - Description: Loop B long-polls `getUpdates`, drops updates outside `chat_id` and `owner_ids`, records seen chats and topics in the state, and routes messages in agent topics: short keys while `blocked` → `hc keys`, other text → `hc send`, refused while `blocked`; `/screen` → `hc read`; `/stop` → `esc`. Commands in the wrong topic answer where they work.
  - Acceptance:
    - [ ] Routing table of the spec is covered by tests, including the refusals
    - [ ] Updates from other users or chats change nothing and are logged
    - [ ] The update offset survives a restart
  - Verify: tests pass; manual: prompt an agent from the phone, `/screen`, `/stop`
  - Dependencies: 4
  - Files: `telegram/commands.mjs`, `telegram/bridge.mjs`, `telegram/test/commands.test.mjs`
  - Scope: M

- [x] **Task 6: `done` and `blocked` posts**
  - Description: On `done`, post the last assistant message from the transcript (`~/.cache/corral/sessions/<pid>.json` → `transcript_path`), else the last 20 screen lines. On `blocked`, wait 1.5 s and post the last 25 screen lines with sound. Split text over 3500 characters.
  - Acceptance:
    - [ ] The last reply is read from a fixture transcript; missing transcript falls back to the screen
    - [ ] `blocked` posts notify with sound; `done` posts use the default notification
    - [ ] Long text is split without breaking a code block
  - Verify: tests pass; manual: finish a turn and trigger a permission prompt
  - Dependencies: 4
  - Files: `telegram/agents.mjs`, `telegram/transcript.mjs`, `telegram/test/transcript.test.mjs`, `telegram/test/fixtures/transcript.jsonl`
  - Scope: M

### Checkpoint 2: Agent topics end to end
- [ ] Tests pass
- [ ] User stories 2, 3, 4, 5 (text replies), 6 work with a real bot
- [ ] Review with the user

## Phase 3: Buttons, root topic, files

- [x] **Task 7: Option buttons on `blocked` posts**
  - Description: Parse a numbered dialog (2–9 options) from the screen into buttons `<n> · <label>`. Callback ids live in memory. A press on the latest open question sends the digit and edits the post to `✅ <n> · <label>`; stale and expired presses answer and do nothing.
  - Acceptance:
    - [ ] Parser fixtures from real Claude Code screens (permission prompt, question) give the right options
    - [ ] Stale button (agent moved on, newer question) does nothing and says so
    - [ ] Every callback gets `answerCallbackQuery`
  - Verify: tests pass; manual: answer a permission prompt with a button
  - Dependencies: 6
  - Files: `telegram/dialog.mjs`, `telegram/commands.mjs`, `telegram/test/dialog.test.mjs`, `telegram/test/fixtures/screens/*.txt`
  - Scope: M

- [x] **Task 8: `/close`, Delete topic and `/clear`**
  - Description: `/close` asks End & close / End & delete / Cancel; both end the agent with `hc kill`. The `Agent ended` post gets a Delete topic button. `/clear` in the root topic asks to delete all `ended` topics.
  - Acceptance:
    - [ ] Close keeps the topic closed in `ended`; Delete removes it and leaves no `ended` entry
    - [ ] `/clear` deletes only topics in `ended`, never the root topic or a live agent's topic
    - [ ] Nothing is deleted without a confirm press by an owner
  - Verify: tests pass; manual: both `/close` paths and `/clear` with two ended agents
  - Dependencies: 5, 7 (callback handling)
  - Files: `telegram/commands.mjs`, `telegram/agents.mjs`, `telegram/test/close.test.mjs`
  - Scope: M

- [x] **Task 9: Root topic: `/status`, dashboard, `/help`, command menu**
  - Description: `/status` lists live agents with emoji, `where`, time in state and a topic link. The pinned dashboard shows the same text, `updated HH:MM` and Clear all (N) while `ended` is not empty; it is edited at most once per 10 s. `setMyCommands` with chat scope at start. `/help` per topic kind.
  - Acceptance:
    - [ ] Dashboard is created once, pinned, and edited in place after restarts
    - [ ] Clear all appears only with ended topics and asks like `/clear`
    - [ ] The "≡" menu shows the 7 commands with the spec's descriptions
  - Verify: tests pass; manual: menu, `/status`, dashboard updates
  - Dependencies: 4, 8
  - Files: `telegram/dashboard.mjs`, `telegram/commands.mjs`, `telegram/bridge.mjs`, `telegram/test/dashboard.test.mjs`
  - Scope: M

- [x] **Task 10: `/new` with space buttons**
  - Description: `/new` in the root topic lists the spaces from `doc.get herdr-app` as buttons. A press starts `claude` in that space the way Task 1 verified, or answers with the fallback.
  - Acceptance:
    - [ ] Buttons match the spaces in Herdr.app
    - [ ] A press starts one agent in that space; its topic appears through the normal sync
    - [ ] `/new` outside the root topic answers where it works
  - Verify: tests pass; manual: user story 1
  - Dependencies: 1, 9
  - Files: `telegram/commands.mjs`, `telegram/herdr.mjs`, `telegram/test/new.test.mjs`
  - Scope: S

- [x] **Task 11: Photos and files to the agent**
  - Description: A photo (largest size) or document in an agent topic is downloaded with `getFile` into `inbox/<address>/<time>-<clean name>`, passed with `hc put`, and the agent gets `"<caption> <path>"` through `hc send`. Over 20 MB and `blocked` are refused.
  - Acceptance:
    - [ ] File names are reduced to `[A-Za-z0-9._-]` and cannot leave the inbox
    - [ ] Caption and path arrive as one prompt
    - [ ] Over-limit and blocked cases answer with the reason
  - Verify: tests pass; manual: send a screenshot and a PDF to an agent
  - Dependencies: 5
  - Files: `telegram/files.mjs`, `telegram/commands.mjs`, `telegram/test/files.test.mjs`
  - Scope: S

### Checkpoint 3: Feature complete
- [ ] Tests pass
- [ ] User stories 1–12 work with a real bot
- [ ] Review with the user

## Phase 4: Delivery

- [x] **Task 12: `install.sh` and README**
  - Description: `install.sh` copies (or with `--link` symlinks) `telegram/` into `$HERDR_APP_HOME/corral/telegram/`. README gets a Telegram section: bot and group setup, rights, `telegram.json` by hand until tg-settings, `--check`, running in the foreground, muting the group.
  - Acceptance:
    - [ ] A fresh `./install.sh` puts the daemon in place; `--check` runs from there
    - [ ] README steps work from a clean state
  - Verify: run `./install.sh`, then `node ~/.config/herdr-app/corral/telegram/bridge.mjs --check`
  - Dependencies: 11
  - Files: `install.sh`, `README.md`
  - Scope: S

### Checkpoint 4: Done
- [ ] Spec success criteria 1–7 met
- [ ] Ready for review (`code-review-and-quality`, `security-and-hardening`)
