# Spec: tg-bridge — V1

Module `tg-bridge` of [CAPABILITY-MAP.md](CAPABILITY-MAP.md).

## Objective

Work with the Herdr agents on this Mac from Telegram as at the desk. The user
is one person: the owner of the Mac and of the bot.

A Telegram supergroup with Topics enabled holds:

- **The root topic** (General, or a topic the user picks). Here the user starts
  agents (`/new`) and sees all live agents (`/status` and a pinned dashboard).
- **One topic per live Claude Code agent.** Messages in it go to the agent.
  The agent's status changes and replies come back into it. The topic lives
  until the agent ends.

The bridge is a daemon next to herdr-core. It talks to Telegram through the
Bot API and to the agents through `hc`. It runs without the Herdr.app window,
so the user can close the app and keep working from the phone. It does not run
while the Mac sleeps; Telegram keeps the updates for 24 hours and the daemon
reads them after wake-up.

### User stories

1. In the root topic I send `/new`. The bot shows a button per Herdr space. I
   press one. A Claude Code agent starts in a new tab of that space, and its
   topic appears in the group.
2. An agent starts at the desk. Its topic appears in the group within 5 s.
3. In an agent's topic I write text. The agent gets it as a prompt.
4. The agent finishes its turn. Its topic gets the agent's last reply.
5. The agent asks a question or waits for approval. Its topic gets the screen
   with the question and one button per numbered option. I press a button, or
   reply `1`, `y` or `esc`, and the agent gets that key.
6. The topic name shows the agent's status as a leading emoji.
7. In an agent's topic I send `/close`. I choose **End & close topic** or
   **End & delete topic**. The agent ends; its topic is closed or deleted.
8. An agent ends at the desk. Its topic gets 🏁, is closed, and its last
   message has a **Delete topic** button.
9. `/status` anywhere lists all live agents with status and a link to their topic.
10. The bot's command menu (the "≡" button) lists the commands with descriptions.
11. In the root topic I send `/clear` or press **Clear all** under the
    dashboard. After I confirm, the topics of all ended agents are deleted.
12. In an agent's topic I send a photo or a file, with or without a caption.
    The agent gets the file's path and the caption as a prompt.

## Tech Stack

- Node.js 20 or newer (built-in `fetch`, `node:test`). No npm dependencies,
  no `package.json` dependencies, no build step. ES modules (`.mjs`).
- Telegram Bot API over HTTPS, long polling (`getUpdates`). No webhook, no
  open port. The bot is a group admin with **Manage topics**, **Delete
  messages** and **Pin messages** (`deleteForumTopic` needs delete rights).
  `getFile` downloads files up to 20 MB, the Bot API limit.
- herdr-core through the `hc` CLI (`ls`, `events`, `run`, `send`, `keys`,
  `read`, `kill`, `put`) and `hc connect` (JSON-RPC) for `doc.get`.

### Facts this design rests on

Verified on this Mac (hc 0.1.21):

- `hc events --json` prints a snapshot of all terminals, then one JSON line per
  change: `created`, `status`, `title`, `labels`, `finished`, `removed`, …
- A terminal's `status` is `{ app, state }`; `app` is `claude-code` for Claude
  Code; `state` is one of `idle`, `working`, `done`, `blocked`.
- Herdr.app labels its terminals `herdr.space=<space id>`,
  `herdr.tab=<tab id>` and `where=<space> / <tab>`.
- `doc.get { name: "herdr-app" }` returns `{ spaces: [{ id, name, folder, tabs }] }`.
- A terminal's `foreground.pid` is the Claude Code process. The Corral
  statusline hook saves `~/.cache/corral/sessions/<pid>.json`, which carries
  the session's `transcript_path`.

Not yet verified (task 1 of the plan checks it):

- `hc run --bg --cwd <folder> --label herdr.space=<id> --label herdr.tab=<new id> claude`
  makes Herdr.app adopt the terminal as a new tab of that space. Fallback if
  not: start through Herdr.app's own command when the app runs, and refuse
  `/new` with a clear reason when it does not.

## Commands

```
Test:    node --test telegram/test/
Run:     node telegram/bridge.mjs            # foreground, logs to stderr
Check:   node telegram/bridge.mjs --check    # validates config, token, chat, hc; sends nothing
Install: ./install.sh                        # also copies telegram/ (see Project Structure)
```

## Project Structure

```
telegram/
  bridge.mjs        entry point: load config, start the two loops, write state
  telegram.mjs      Bot API calls: getUpdates, sendMessage, forum topics, commands
  herdr.mjs         hc calls: events stream, run, send, keys, read, kill, doc.get
  agents.mjs        agent ↔ topic sync, status emoji, notification texts
  commands.mjs      /new /status /screen /stop /close /help and plain text routing
  config.mjs        read and validate telegram.json, read/write telegram-state.json
  test/*.test.mjs   node:test unit tests with fakes for Telegram and hc
```

Installed by `install.sh` into `$HERDR_APP_HOME/corral/telegram/`
(default `~/.config/herdr-app/corral/telegram/`). Settings and state sit next to
it in `$HERDR_APP_HOME/corral/`. No absolute path is written in the code: paths
come from `HERDR_APP_HOME`, `HOME` and `HC_BIN` (default `hc` on `PATH`).

### Files (the contract with tg-settings)

`telegram.json` — settings. tg-settings writes it; the bridge reads it at start
and when the file changes.

```json
{
  "token": "123456:ABC…",
  "chat_id": -1001234567890,
  "root_topic_id": null,
  "owner_ids": [123456789]
}
```

- `root_topic_id`: `null` means General.
- `owner_ids`: Telegram user ids allowed to control the bot. Updates from
  any other user or chat are dropped and logged.

`telegram-state.json` — state. Only the bridge writes it (atomic write: temp
file, then rename).

```json
{
  "daemon": { "pid": 4242, "started_at": "…", "heartbeat_at": "…",
              "status": "running", "error": null, "bot": "my_corral_bot" },
  "offset": 912345678,
  "chats": [{ "id": -1001234567890, "title": "Corral", "forum": true }],
  "topics": { "-1001234567890": [{ "id": 17, "name": "Corral" }] },
  "agents": { "t1y": { "topic_id": 42, "title": "⚡ gmail / Claude Code", "state": "working" } },
  "ended": [{ "topic_id": 37, "title": "🏁 xnms / 1", "ended_at": "…" }],
  "dashboard_message_id": 1001
}
```

- `daemon.status`: `running`, `stopped` or `error` (with `error` text).
  `heartbeat_at` is updated every 30 s.
- `chats` and `topics` hold every group and topic the bot has seen in updates
  (`my_chat_member`, messages, `forum_topic_created`). The Bot API cannot list
  them, so the wizard in tg-settings reads them from here.
- `agents` maps a terminal address to its topic, so a restart reuses topics
  and does not duplicate them.
- `ended` lists the closed topics of ended agents that still exist, for
  **Delete topic** and **Clear all**. A deleted topic leaves the list.

## Behaviour

### Agent topics

- An agent is a live terminal whose `status.app` is `claude-code` and that has
  no `parent` (helpers started by an agent are not agents).
- On a new agent: `createForumTopic` with the name `<emoji> <where>`, store the
  mapping, post one line: `Started in <cwd>`.
- On a status change: rename the topic (`editForumTopic`) with the new emoji.
  Emoji: `working` ⚡, `blocked` ❓, `done` ✅, `idle` 💤, ended 🏁.
  Renames for one topic are throttled to one per 10 s; the last state wins.
- On `done`: post the last assistant message from the session transcript.
  Without a transcript, post the last 20 screen lines as a code block.
  Text longer than 3500 characters is split into several messages.
- On `blocked`: wait 1.5 s, then post the last 25 screen lines as a code block
  with `Waiting for you`. This message notifies with sound. When the screen
  ends in a numbered dialog with 2–9 options (lines such as `❯ 1. Yes`,
  `  2. No`), the message gets one inline button per option: `1 · Yes`.
- `working` and `idle` change only the topic name: no message.
- On `finished` or `removed`: rename with 🏁, post `Agent ended` with a
  **Delete topic** button, call `closeForumTopic`, move the mapping to `ended`.
- On start the bridge reconciles: it reuses mapped topics of live agents,
  closes topics of agents that ended while it was down, creates missing ones.

### Inline buttons

- Every button's `callback_data` carries an action and a short id the bridge
  keeps in memory (Telegram limits it to 64 bytes). The bridge always answers
  with `answerCallbackQuery`.
- A dialog option button acts only while it belongs to the agent's latest
  `blocked` post and the agent is still `blocked`. It sends the option's digit
  (`hc keys <t> <n>`) and edits the post to `✅ <n> · <option>`. A stale button
  answers `This question is no longer open` and does nothing.
- After a restart the in-memory ids are gone: old buttons answer
  `This button has expired`.

### Messages in an agent topic

| Input | Action |
|---|---|
| plain text, agent `blocked`, text is `y`, `n`, `1`…`9`, `enter`, `esc` | `hc keys <t> <key>` |
| plain text, otherwise | `hc send <t> <text>`; when `blocked`, refused with a hint to answer the dialog first |
| `/screen` | last 40 screen lines (`hc read`) as a code block |
| `/stop` | `hc keys <t> esc`; reply `⏹ sent esc` |
| `/close` | question with **End & close topic** / **End & delete topic** / **Cancel** buttons. Close → `hc kill <t>`, then the ended path above. Delete → `hc kill <t>`, then `deleteForumTopic`, no `ended` entry. |
| photo or document, optional caption | download with `getFile` into `$HERDR_APP_HOME/corral/inbox/<address>/<time>-<name>`, then `hc put <t> <file>`; `hc send <t> "<caption> <path>"` with the path `hc put` printed. Photos take the largest size. Over 20 MB: refused with the limit. While `blocked`: refused like text. |
| `/status`, `/help` | as in the root topic |
| `/new`, `/clear` | hint: use the root topic |

In the closed topic of an ended agent, the **Delete topic** button deletes it
(`deleteForumTopic`) and removes it from `ended`. Text there answers
`Agent has ended`.

Text and file paths go to `hc` as argv elements, never through a shell. File
names from Telegram are reduced to `[A-Za-z0-9._-]`, so a name cannot leave
the inbox folder.

### Root topic

| Input | Action |
|---|---|
| `/new` | one inline button per space from `doc.get herdr-app` (name; folder as tooltip text in the message). A press starts `claude` in that space (see Facts) and answers `Starting Claude in <space>…`. The topic appears through the normal agent sync. |
| `/status` | each live agent: emoji, `where`, time in the current state, link to its topic. |
| `/clear` | `Delete N topics of ended agents?` with **Delete all** / **Cancel**. Delete all → `deleteForumTopic` for each entry of `ended`, then `Deleted N topics`. With no ended topics: `Nothing to clear`. |
| `/help` | the command list for this topic |
| other text | ignored |

The pinned dashboard is the `/status` text plus `updated HH:MM`, and a
**Clear all (N)** button while `ended` is not empty. The button asks the same
question as `/clear`. The bridge edits the dashboard on every status change, at
most once per 10 s.

### Command menu

At start: `setMyCommands` with scope `{ type: "chat", chat_id }`:

| Command | Description |
|---|---|
| `new` | Start an agent in a workspace |
| `status` | All agents and their status |
| `screen` | Show the agent's screen |
| `stop` | Stop the current turn (Esc) |
| `close` | End the agent, close or delete its topic |
| `clear` | Delete the topics of ended agents |
| `help` | What the bot can do here |

Telegram has no per-topic menu, so a command used in the wrong topic answers
with where it works.

### Resilience

- Telegram errors: retry with backoff (1 s → 60 s). `429` waits `retry_after`.
  `401` (bad token) stops the daemon with `status: "error"`.
- `hc events` ends or `hc` is missing: retry every 5 s, `status: "error"`
  with the reason until it is back.
- One instance only: a lock file `telegram.lock` with the pid. A second start
  exits with a message.
- Logs go to stderr, one line per event, without the token.

## Code Style

ES modules, small functions, a comment above each block that says why, as in
`mods/corral/main.js` and `install.sh`. No classes unless state needs one.

```js
// One Bot API call. The token never reaches a log line: errors carry the method only.
export async function call(token, method, params = {}) {
  const res = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(params),
  });
  const body = await res.json();
  if (!body.ok) throw new TelegramError(method, body.error_code, body.description, body.parameters);
  return body.result;
}
```

## Testing Strategy

- `node:test`, files in `telegram/test/`. No real network or `hc` in unit tests:
  `telegram.mjs` and `herdr.mjs` take an injected transport, tests pass fakes.
- Unit tests cover: event → action mapping (status → rename/post), text routing
  (keys vs send vs refuse), dialog parsing into buttons, stale and expired
  buttons, close vs delete, `/clear`, file name cleaning and the inbox path,
  owner and chat filtering, message splitting, reconcile after restart, state
  file read/write.
- Manual end-to-end check on this Mac with a real bot and group, following
  the user stories above, before the module is called done.

## Boundaries

- **Always:** pass user text to `hc` as argv; drop updates from unknown chats
  and users; keep the token out of logs and state; run tests before a commit.
- **Ask first:** adding any npm dependency; changing `mods/corral/main.js`
  (that is tg-settings); changing the file contract above.
- **Never:** run user text through a shell; act on updates from users outside
  `owner_ids`; delete a topic without the owner's press on a confirm button;
  delete the root topic or the topic of a live agent other than through
  **End & delete topic**; write a file outside the inbox; commit a token.

## Success Criteria

1. `node --test telegram/test/` passes.
2. `node telegram/bridge.mjs --check` reports token, chat and `hc` as OK.
3. With the daemon running, each user story 1–12 works on this Mac with a real
   bot and group.
4. An agent started at the desk gets its topic within 5 s.
5. Restarting the daemon creates no duplicate topics.
6. A message from a user not in `owner_ids` changes nothing and is logged.
7. Closing the Herdr.app window does not stop the bridge.

## Out of Scope (Deferred)

- Settings UI, wizard, launchd start/stop: module tg-settings.
- Agent kinds other than Claude Code in `/new` and in sync: keep V1 small.
- Multi-select dialogs (toggle and submit): single-choice buttons and text
  replies cover the pilot.
- Voice, audio and video to the agent, files from the agent to Telegram:
  not needed for the first pilot.
- Automatic cleanup of the inbox folder: files stay until removed by hand.
- `/git`, `/diff`, quota lines, quiet hours, sharing an agent: nice to have later.
- Token in Keychain or other protection: the user's MVP decision.
- Remote machines, Raspberry Pi, Linux/systemd: V2, the paths are kept portable for it.

## Open Questions

1. Does `hc run` with a new `herdr.tab` label make Herdr.app adopt the terminal
   as a tab? Checked in plan task 1; the fallback is above.
