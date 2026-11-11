import { View, div, svg, image, uniform_list } from "gpui-kit";
import { h_flex, v_flex, Input, InputState, Editor, EditorState, h_resizable, resizable_panel } from "gpui-base";
import {
  agents, spaces, panes, props, run, setAgentOrder, theme, shared, setShared, pickFolder,
  home, hc, exec, readTextFile, openOverlay, closeOverlay, notify, window as appWindow,
} from "herdr";
import * as fs from "fs/promises";

// The mod's folder name: icon paths and popups point back at it.
const MOD = "corral";
const FILTER_KEY = "corral.filter";
const PROJECTS_KEY = "corral.projects";
// Session data from the statusline hook (statusline/corral-statusline.py), published by the board copy.
const LIVE_KEY = "corral.live";
// Board | Files | Changes: what the top area shows.
const VIEW_KEY = "corral.view";
// The agent Files and Changes follow: { address, focus } holds while `focus` is still the focused agent.
const TARGET_KEY = "corral.target";
// git status of the target agent's folder, published by the board copy.
const GIT_KEY = "corral.git";
// Files: show dotfiles. Changes/Files: a worktree picked for an agent, { address, path }.
const HIDDEN_KEY = "corral.hidden";
const WORKTREE_KEY = "corral.worktree";
// Side panel widths in Files and Changes, per agent: { [address]: { files, changes } }.
const WIDTHS_KEY = "corral.widths";
const SIDE_WIDTH = { files: 280, changes: 320 };
// Changes as a folder tree (the default) or a flat list, per repository: { [root]: boolean }.
const CHANGE_TREE_KEY = "corral.changeTree";
const changeTree = () => {
  const root = gitState().root;
  const saved = shared(CHANGE_TREE_KEY);
  return (saved && typeof saved === "object" ? saved[root] : undefined) ?? true;
};
const setChangeTree = (on) => {
  const saved = shared(CHANGE_TREE_KEY);
  setShared(CHANGE_TREE_KEY, { ...(saved && typeof saved === "object" ? saved : {}), [gitState().root]: on });
};
const ATTENTION = ["blocked", "done"];
const RELOAD_MS = 3000;
const PID_RETRY_MS = 10000;
const SYNC_MS = 500;
const GIT_MS = 4000;
const ROW_H = 20;
const WT_POPUP_MAX = 460;
const POPUP_MAX = 560;
const LIMIT_LABELS = { five_hour: "5h", seven_day: "7d" };
const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

const palette = () => {
  const t = theme();
  return { ink: t.foreground, muted: t.muted, dim: t.dim, line: t.border, bg: t.canvas, card: t.background,
    bar: t.chrome, accent: t.accent, selected: t.selected, input: t.input, danger: t.ansi9, fable: t.ansi13 };
};
const wash = (color, C, alpha = "26") => /^#[0-9a-f]{6}$/i.test(color) ? color + alpha : C?.selected ?? theme().selected;
const states = () => {
  const t = theme();
  return [
    { key: "blocked", label: "Needs you", color: t.blocked },
    { key: "working", label: "Working", color: t.working },
    { key: "done", label: "Done", color: t.done },
    { key: "idle", label: "Idle", color: t.idle },
  ];
};
// A framed search field with a magnifier, for the popup lists.
const searchField = (C, state) => h_flex().flex_none().h(32).mx(4).mb(4).px(10).gap(8).items_center().rounded(6)
  .bg(C.card).border_1().border_color(C.input).text_size(12)
  .child(svg(`mods/${MOD}/icons/search.svg`).size(14).text_color(C.muted).flex_none())
  .child(div().flex_1().min_w(0).child(Input.new(state)));
// The picker sits after the view switch and the slash; its popups open under it.
const PICKER_X = 310;
// Copy-path chords: Cmd on macOS, Ctrl elsewhere (GPUI's "cmd" is the Windows/Super key there).
// The window is not there while the module loads, so this is asked on use.
const copyKeys = () => (appWindow()?.platform ?? "macos") === "macos"
  ? { relative: "cmd-shift-c", absolute: "alt-shift-c", relLabel: "⌘⇧C", absLabel: "⌥⇧C" }
  : { relative: "ctrl-shift-c", absolute: "alt-shift-c", relLabel: "Ctrl+Shift+C", absLabel: "Alt+Shift+C" };
const copyText = (cx, text) => cx.write_to_clipboard(text);
const pctColor = (C, pct) => pct >= 80 ? C.danger : pct >= 60 ? theme().blocked : C.accent;
const tilde = (path) => {
  const h = home();
  return path && path.startsWith(h) ? "~" + path.slice(h.length) : path ?? "";
};
const baseName = (path) => path.split("/").filter(Boolean).pop() ?? path;
const pad2 = (n) => String(n).padStart(2, "0");
const resetText = (resetsAt) => {
  if (!resetsAt) return "";
  const d = new Date(resetsAt * 1000);
  const h = d.getHours();
  const clock = `${h % 12 || 12}:${pad2(d.getMinutes())} ${h < 12 ? "AM" : "PM"}`;
  return resetsAt * 1000 - Date.now() < 86400000 ? clock : `${DAYS[d.getDay()]} ${clock}`;
};

// projects / statuses: null shows all; a list shows only those project folders / status keys.
const filter = () => ({ projects: null, statuses: null, ...(shared(FILTER_KEY) ?? {}) });
const setFilter = (change) => setShared(FILTER_KEY, { ...filter(), ...change });
const projects = () => shared(PROJECTS_KEY) ?? [];
const live = () => shared(LIVE_KEY) ?? { sessions: {}, limits: [] };
const view = () => shared(VIEW_KEY) ?? "board";
const gitState = () => shared(GIT_KEY) ?? { folder: null, root: null, branch: "", files: [], worktrees: [] };
const showHidden = () => !!shared(HIDDEN_KEY);
const targetAgent = () => {
  const all = agents();
  const focused = all.find(a => a.focused);
  const t = shared(TARGET_KEY);
  const picked = t && all.find(a => a.address === t.address);
  if (picked && (!focused || focused.address === t.focus)) return picked;
  return focused ?? picked ?? all[0] ?? null;
};
const agentFolder = (a) => a && (panes().find(p => p.terminal === a.address)?.cwd ?? live().sessions[a.address]?.folder ?? null);
// The folder Files and Changes show: a picked worktree of the target agent, else its own folder.
const viewFolder = () => {
  const a = targetAgent();
  const wt = shared(WORKTREE_KEY);
  return a && wt?.address === a.address ? wt.path : agentFolder(a);
};
const agentProjects = () => projectRows(agents()).filter(r => r.agents.length);
const checkListHeight = (n) => Math.min(POPUP_MAX, 60 + (n + 1) * 46);
// The board shows the columns of the picked statuses only.
const shownStates = () => states().filter(s => !filter().statuses || filter().statuses.includes(s.key));
const visibleAgents = (active) => {
  const f = filter();
  const all = agents();
  const shown = f.projects && new Set(projectRows(all).filter(r => f.projects.includes(r.folder)).flatMap(r => r.agents.map(a => a.address)));
  return all.filter(a => (!shown || shown.has(a.address)) && (!f.statuses || f.statuses.includes(a.status)));
};
// One row per folder: saved projects, then folders of agents outside them.
// Each agent counts once, in the deepest folder that holds it. Rows with agents go first, then open ones.
const projectRows = (all) => {
  const open = spaces().filter(s => s.folder && !s.machine);
  const rows = projects().map(p => ({ ...p, saved: true, agents: [] }));
  for (const a of all) {
    const f = agentFolder(a) ?? spaces().find(s => s.id === a.space)?.folder;
    if (!f) continue;
    let best = null;
    for (const r of rows) {
      if ((f === r.folder || f.startsWith(r.folder + "/")) && (!best || r.folder.length > best.folder.length)) best = r;
    }
    if (!best) rows.push(best = { name: baseName(f), folder: f, saved: false, agents: [] });
    best.agents.push(a);
  }
  for (const r of rows) {
    r.space = open.find(s => s.folder === r.folder) ?? null;
    r.agents.sort((x, y) => ATTENTION.includes(y.status) - ATTENTION.includes(x.status));
  }
  const rank = (r) => r.agents.length ? 0 : r.space ? 1 : 2;
  return rows.sort((x, y) => rank(x) - rank(y));
};
// Popups get an explicit height: without one the scroll list (flex_1) collapses to nothing.
const projectsPopupHeight = () => Math.min(POPUP_MAX, 124 + projectRows(agents()).length * 54);
const worktreesPopupHeight = () => Math.min(WT_POPUP_MAX, 92 + gitState().worktrees.length * 50);
const matches = (q, ...texts) => !q || texts.some(t => (t ?? "").toLowerCase().includes(q));
// macOS: a native dialog that takes several folders at once. Elsewhere, or if it can't run, Herdr's single picker.
const pickFolders = async () => {
  const script = [
    "activate",
    'set picked to choose folder with prompt "Add projects" with multiple selections allowed',
    'set out to ""',
    "repeat with f in picked",
    "set out to out & POSIX path of f & linefeed",
    "end repeat",
    "return out",
  ];
  try {
    const r = await exec("osascript", script.flatMap(line => ["-e", line]), { timeout: 600000 });
    if (r.code === 0) return r.stdout.split("\n").map(f => f.trim().replace(/\/$/, "")).filter(Boolean);
    if (r.stderr.includes("-128")) return [];
  } catch { /* not macOS */ }
  const folder = await pickFolder({ prompt: "Add project" });
  return folder ? [folder] : [];
};
const removeProject = (folder) => setShared(PROJECTS_KEY, projects().filter(p => p.folder !== folder));
// Reuse the project's space when one is open there; otherwise start a space for it.
const openProject = (p) => {
  const space = spaces().find(s => s.folder === p.folder && !s.machine);
  if (space) {
    run("space.select", { id: space.id });
    run("tab.new", { space: space.id, folder: p.folder, name: "claude", argv: ["claude"] });
  } else {
    run("space.new", { name: p.name, folder: p.folder, tab: "claude", argv: ["claude"] });
  }
};

const summarize = (d) => ({
  sid: d.session_id ?? "",
  model: d.model?.display_name ?? "",
  ctx: Math.round(d.context_window?.used_percentage ?? 0),
  tokens: d.context_window?.total_input_tokens ?? 0,
  cost: d.cost?.total_cost_usd ?? 0,
  folder: d.workspace?.current_dir ?? d.cwd ?? "",
  title: d.session_name ?? "",
});
// five_hour and seven_day are plan-wide; any other window (a per-model one, e.g. Fable) is grouped by model.
const limitsOf = (rl) => Object.entries(rl ?? {}).filter(([, v]) => v && v.used_percentage != null).map(([key, v]) => ({
  key,
  group: LIMIT_LABELS[key] ? "" : (key.match(/fable|opus|sonnet|haiku/i)?.[0] ?? key),
  label: LIMIT_LABELS[key] ?? (key.includes("seven_day") ? "7d" : key.includes("five_hour") ? "5h" : key),
  pct: Math.round(v.used_percentage),
  reset: resetText(v.resets_at),
}));

const dot = (color, size = 7) => div().size(size).rounded(size).bg(color).flex_none();
const icon = (C, program, size = 18) => program?.icon
  ? (program.tint ? svg(program.icon).text_color(C.ink) : image(program.icon)).size(size).flex_none()
  : div().size(size).rounded(4).bg(C.accent);
const MARK_COLORS = { M: "blocked", A: "done", D: "ansi9" };
const markColor = (mark) => theme()[MARK_COLORS[mark]] ?? theme().muted;
const badge = (mark) => div().px(5).rounded(4).bg(wash(markColor(mark))).font_family("Geist Mono").text_size(10)
  .text_color(markColor(mark)).flex_none().child(mark);
const relPath = (root, path) => root && path.startsWith(root + "/") ? path.slice(root.length + 1) : path;
// Read-only code view: the editor brings selection, copy, line numbers and highlighting.
const LANGUAGES = {
  js: "javascript", mjs: "javascript", cjs: "javascript", jsx: "javascript", ts: "typescript", tsx: "tsx",
  py: "python", rs: "rust", go: "go", json: "json", md: "markdown", sh: "bash", bash: "bash", zsh: "bash",
  yml: "yaml", yaml: "yaml", toml: "toml", html: "html", css: "css", c: "c", h: "c", cpp: "cpp", hpp: "cpp",
  java: "java", rb: "ruby", sql: "sql", swift: "swift", kt: "kotlin", lua: "lua", diff: "diff",
};
const SYNTAX_DARK = {
  keyword: "#b477cf", string: "#a1c181", "string.escape": "#878a97", comment: "#5d636f", function: "#73ade9",
  type: "#6eb4bf", number: "#bf956a", boolean: "#bf956a", constant: "#dfc184", variable: "#dce0e5",
  operator: "#6eb4bf", punctuation: "#acb2be",
};
const SYNTAX_LIGHT = {
  keyword: "#9a2fc2", string: "#2f8a2a", "string.escape": "#0b7aa3", comment: "#808187", function: "#2f55d0",
  type: "#a86e00", number: "#a2510a", boolean: "#a2510a", constant: "#a2510a", variable: "#24262c",
  operator: "#0b7aa3", punctuation: "#3a3c42",
};
// Light or dark by the theme's background, so code colors read on either.
const isLight = () => {
  const m = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})/i.exec(theme().background ?? "");
  return !!m && (0.299 * parseInt(m[1], 16) + 0.587 * parseInt(m[2], 16) + 0.114 * parseInt(m[3], 16)) > 140;
};
const languageOf = (path) => LANGUAGES[path.split("/").pop().split(".").pop().toLowerCase()];
const newEditor = (path) => {
  // Folding adds a column of fold marks, which also keeps the code off the line numbers.
  const options = { readonly: true, line_numbers: true, folding: true, soft_wrap: false, font_family: "Geist Mono", font_size: 12, syntax: isLight() ? SYNTAX_LIGHT : SYNTAX_DARK };
  const language = languageOf(path);
  try { return EditorState.new(language ? { ...options, language } : options); } catch { return EditorState.new(options); }
};
const kTokens = (n) => `${Math.round(n / 1000)}k`;
const iconButton = (C, id, tip, file, onClick) => div().id(id).size(22).flex().flex_none().items_center().justify_center()
  .rounded(5).text_color(C.muted).cursor_pointer().hover(s => s.bg(C.selected).text_color(C.ink))
  .tooltip(tip).on_click((e, cx) => { cx.stop_propagation(); onClick(e, cx); })
  .child(svg(`mods/${MOD}/icons/${file}.svg`).size(14));
const meter =(C, width, pct, color) => div().w(width).h(6).rounded(6).bg(C.selected).overflow_hidden().flex_none()
  .child(div().h(6).rounded(6).w(`${Math.min(100, Math.max(0, pct))}%`).bg(color));
const chip = (C, id, label, selected, onClick) => h_flex().id(id).h(28).px(11).gap(7).items_center().rounded(6).flex_none()
  .bg(selected ? C.selected : C.card).border(1).border_color(selected ? C.input : C.line)
  .text_size(11).text_color(selected ? C.accent : C.muted).cursor_pointer().hover(s => s.border_color(C.input))
  .on_click(onClick).child(label);
const xButton = (C, id, tip, onClick, size = 22, glyph = 13) => div().id(id).size(size).flex().flex_none().items_center().justify_center()
  .rounded(5).text_size(glyph).text_color(C.dim).cursor_pointer().hover(s => s.bg(C.selected).text_color(C.ink))
  .tooltip(tip).on_click((e, cx) => { cx.stop_propagation(); onClick(e, cx); }).child("×");
const limitPill = (C, items, title, titleColor, border) => h_flex().h(34).px(12).gap(10).items_center().rounded(7).flex_none()
  .bg(C.bg).border(1).border_color(border)
  .when(!!title, el => el.child(div().text_size(12).font_semibold().text_color(titleColor).child(title)))
  .children(items.map(l => h_flex().gap(8).items_center()
    .child(div().text_size(12).font_semibold().text_color(C.ink).child(l.label))
    .child(meter(C, title ? 60 : 80, l.pct, title ? C.fable : pctColor(C, l.pct)))
    .child(div().font_family("Geist Mono").text_size(12).text_color(title ? C.fable : pctColor(C, l.pct)).child(`${l.pct}%`))
    .when(!!l.reset, el => el.child(div().text_size(11).text_color(C.muted).child(`resets ${l.reset}`)))));

export default class Board extends View {
  init(_props, cx) {
    // The props argument comes in empty; props() has the role.
    const p = props();
    this.observed = {};
    this.confirming = null;
    if (p?.role === "spaces") {
      this.spaceSearch = InputState.new({ placeholder: "Filter projects" });
      this.spaceSearch.on("change", (_e, cx) => cx.notify());
      this.spaceSearch.focus();
    }
    if (p?.role === "terminals") this.railFocus = cx.focus_handle();
    if (!p?.role || p.role === "header") this.selfFocus = cx.focus_handle();
    if (p?.role === "worktrees") {
      this.wtSearch = InputState.new({ placeholder: "Search branch or path" });
      this.wtSearch.on("change", (_e, cx) => cx.notify());
      this.wtSearch.focus();
    }
    cx.timer.every(30000, (cx) => cx.notify());
    // Only the board copy reads the session files; the header and pane copies read its shared summary.
    if (!p?.role) {
      this.treeFocus = cx.focus_handle();
      const keys = copyKeys();
      cx.bind_keys([
        { keystroke: keys.relative, action: "corral-copy-relative", context: "CorralPaths" },
        { keystroke: keys.absolute, action: "corral-copy-absolute", context: "CorralPaths" },
      ]);
      // Saved projects from the Board layout this grew out of come along once.
      if (shared(PROJECTS_KEY) == null && shared("board.projects")) setShared(PROJECTS_KEY, shared("board.projects"));
      this.dir = `${home()}/.cache/corral/sessions`;
      this.pids = {};
      this.lookedUp = {};
      this.liveText = "";
      cx.spawn(async () => this.reload());
      cx.timer.every(RELOAD_MS, (cx) => { cx.spawn(async () => this.reload()); });
      // Files and Changes: the tree, the open file and the diff follow the target agent's folder.
      this.folder = null;
      this.expanded = new Set();
      this.dirs = {};
      this.dirError = null;
      this.file = null;
      this.treeSel = null;
      this.changeSel = null;
      this.diff = null;
      this.gitAt = 0;
      cx.timer.every(SYNC_MS, (cx) => this.sync(cx));
    }
  }
  sync(cx) {
    // A space opened in a new folder makes that folder a project.
    const known = new Set(projects().map(p => p.folder));
    const fresh = [...new Set(spaces().filter(s => s.folder && !s.machine && !known.has(s.folder)).map(s => s.folder))];
    if (fresh.length) setShared(PROJECTS_KEY, [...projects(), ...fresh.map(folder => ({ name: baseName(folder), folder }))]);
    const folder = viewFolder();
    if (folder !== this.folder) {
      this.folder = folder;
      this.expanded = new Set();
      this.dirs = {};
      this.dirError = null;
      this.file = null;
      this.treeSel = null;
      this.changeSel = null;
      this.diff = null;
      this.gitAt = 0;
      if (folder) this.loadDir(folder, cx);
      cx.notify();
    }
    if (Date.now() - this.gitAt >= GIT_MS) {
      this.gitAt = Date.now();
      cx.spawn(async () => this.refreshGit(folder));
    }
    if (view() === "changes") this.loadDiff(cx);
  }
  async refreshGit(folder) {
    const next = { folder, root: null, branch: "", files: [], worktrees: [] };
    if (folder) {
      const git = (args) => exec("git", args, { cwd: folder, timeout: 10000 });
      try {
        const top = await git(["rev-parse", "--show-toplevel"]);
        if (top.code === 0) {
          next.root = top.stdout.trim();
          next.branch = (await git(["branch", "--show-current"])).stdout.trim();
          for (const block of (await git(["worktree", "list", "--porcelain"])).stdout.split("\n\n")) {
            const path = block.match(/^worktree (.+)$/m)?.[1];
            if (!path) continue;
            const branch = block.match(/^branch refs\/heads\/(.+)$/m)?.[1] ?? (block.includes("\ndetached") ? "detached" : "");
            next.worktrees.push({ path, branch });
          }
          const counts = {};
          for (const line of (await git(["diff", "--numstat", "HEAD"])).stdout.split("\n")) {
            const [add, del, ...rest] = line.split("\t");
            if (rest.length) counts[rest.join("\t")] = { add: Number(add) || 0, del: Number(del) || 0 };
          }
          for (const line of (await git(["status", "--porcelain=v1", "--untracked-files=all"])).stdout.split("\n")) {
            if (line.length < 4) continue;
            const xy = line.slice(0, 2);
            const path = line.slice(3).split(" -> ").pop().replace(/^"(.*)"$/, "$1");
            const untracked = xy === "??";
            const mark = untracked || xy.includes("A") ? "A" : xy.includes("D") ? "D" : "M";
            let n = counts[path] ?? { add: 0, del: 0 };
            if (untracked) n = { add: ((await readTextFile(`${next.root}/${path}`)) ?? "").split("\n").length, del: 0 };
            next.files.push({ path, mark, untracked, ...n });
          }
        }
      } catch { /* git missing or the folder is gone */ }
    }
    if (JSON.stringify(next) !== JSON.stringify(gitState())) setShared(GIT_KEY, next);
  }
  loadDir(path, cx) {
    if (this.dirs[path]) return;
    this.dirs[path] = [];
    cx.spawn(async (cx) => {
      let list = null;
      try {
        const entries = await fs.readdir(path, { withFileTypes: true });
        list = entries.map(e => ({ name: e.name, dir: typeof e.isDirectory === "function" ? e.isDirectory() : !!e.isDirectory }));
      } catch (err) { this.dirError = String(err); }
      // Fallback: `ls -p` marks folders with a trailing slash.
      if (!list?.length) {
        try {
          const r = await exec("ls", ["-1Ap", path], { timeout: 10000 });
          if (r.code === 0) list = r.stdout.split("\n").filter(Boolean).map(n => ({ name: n.replace(/\/$/, ""), dir: n.endsWith("/") }));
          else this.dirError = r.stderr.trim() || `ls exited with ${r.code}`;
        } catch (err) { this.dirError = String(err); }
      }
      this.dirs[path] = (list ?? []).sort((a, b) => (b.dir - a.dir) || a.name.localeCompare(b.name));
      cx.notify();
    });
  }
  toggleDir(path, cx) {
    if (this.expanded.has(path)) this.expanded.delete(path);
    else { this.expanded.add(path); this.loadDir(path, cx); }
    cx.notify();
  }
  openFile(path, cx) {
    // Created here, in the click: editor state can't be made during render.
    this.editor?.release();
    this.editor = newEditor(path);
    this.treeSel = path;
    this.file = { path, lines: null, note: "Loading…" };
    cx.notify();
    cx.spawn(async (cx) => {
      const text = await readTextFile(path);
      if (this.file?.path !== path) return;
      if (text == null) this.file = { path, lines: null, note: "Can't show this file: it is gone or over 1 MiB." };
      else if (text.includes("\u0000")) this.file = { path, lines: null, note: "Binary file." };
      else {
        const lines = text.split("\n");
        if (lines.length > 1 && lines[lines.length - 1] === "") lines.pop();
        this.file = { path, lines, size: text.length };
        this.editor.set_value(text);
      }
      cx.notify();
    });
  }
  // Files: open a changed file and expand the folders above it.
  revealFile(path, cx) {
    if (this.folder && path.startsWith(this.folder + "/")) {
      let dir = this.folder;
      for (const part of path.slice(this.folder.length + 1).split("/").slice(0, -1)) {
        dir = `${dir}/${part}`;
        this.expanded.add(dir);
        this.loadDir(dir, cx);
      }
    }
    this.openFile(path, cx);
    setShared(VIEW_KEY, "files");
  }
  loadDiff(cx) {
    const g = gitState();
    const sel = g.files.find(f => f.path === this.changeSel) ?? g.files[0];
    if (!sel || !g.root) { this.diff = null; return; }
    const key = `${g.root}|${JSON.stringify(sel)}`;
    if (this.diff?.key === key) return;
    this.diff = { key, path: sel.path, lines: this.diff?.path === sel.path ? this.diff.lines : null };
    cx.spawn(async (cx) => {
      let lines = [];
      if (sel.untracked) {
        const text = await readTextFile(`${g.root}/${sel.path}`) ?? "";
        lines = text.split("\n").map((t, i) => ({ kind: "add", old: "", now: i + 1, text: t }));
      } else {
        const r = await exec("git", ["diff", "HEAD", "--", sel.path], { cwd: g.root, timeout: 10000 }).catch(() => null);
        let o = 0, n = 0, inHunk = false;
        for (const t of (r?.stdout ?? "").split("\n")) {
          const h = t.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
          if (h) { o = Number(h[1]); n = Number(h[2]); inHunk = true; lines.push({ kind: "hunk", old: "", now: "", text: t }); continue; }
          if (!inHunk || t.startsWith("\\")) continue;
          if (t.startsWith("+")) lines.push({ kind: "add", old: "", now: n++, text: t.slice(1) });
          else if (t.startsWith("-")) lines.push({ kind: "del", old: o++, now: "", text: t.slice(1) });
          else if (t.startsWith(" ") || t === "") lines.push({ kind: "ctx", old: o++, now: n++, text: t.slice(1) });
          else inHunk = false;
        }
      }
      if (this.diff?.key === key) { this.diff.lines = lines; cx.notify(); }
    });
  }
  async reload() {
    if (this.loading) return;
    this.loading = true;
    try {
      let names = [];
      try { names = (await fs.readdir(this.dir)).filter(n => n.endsWith(".json")); } catch { names = []; }
      const byPid = {};
      for (const n of names) {
        try {
          const d = JSON.parse(await readTextFile(`${this.dir}/${n}`) ?? "");
          if (d?.herdr_claude_pid) byPid[d.herdr_claude_pid] = d;
        } catch { /* a file being replaced */ }
      }
      // A session file is keyed by the claude pid; hc knows each agent terminal's foreground pid.
      const now = Date.now();
      for (const a of agents()) {
        if (byPid[this.pids[a.address]]) continue;
        if (now - (this.lookedUp[a.address] ?? 0) < PID_RETRY_MS) continue;
        this.lookedUp[a.address] = now;
        try {
          const r = await hc(["get", a.address, "--json"]);
          this.pids[a.address] = JSON.parse(r.stdout).foreground?.pid;
        } catch { /* terminal gone */ }
      }
      const sessions = {};
      for (const a of agents()) {
        const d = byPid[this.pids[a.address]];
        if (d) sessions[a.address] = summarize(d);
      }
      // A new session has no rate limits until its first reply; take the newest one that has them.
      const latest = Object.values(byPid).filter(d => d.rate_limits)
        .sort((x, y) => (y.herdr_written_at ?? 0) - (x.herdr_written_at ?? 0))[0];
      const next = { sessions, limits: latest ? limitsOf(latest.rate_limits) : [] };
      const text = JSON.stringify(next);
      if (text !== this.liveText) {
        this.liveText = text;
        setShared(LIVE_KEY, next);
      }
    } finally {
      this.loading = false;
    }
  }
  // Drag and drop inside this copy's block: a press arms it, a 5px move starts it, the release drops it.
  // Herdr gives mods no drag events across blocks, so drop zones are drawn in the block itself.
  startDrag(item, e) {
    this.drag = { ...item, x0: e.position.x, y0: e.position.y, moved: false };
    this.dropTarget = null;
    this.suppressClick = false;
  }
  moveDrag(e, cx) {
    const d = this.drag;
    if (!d || d.moved) return;
    if (Math.abs(e.position.x - d.x0) + Math.abs(e.position.y - d.y0) > 5) {
      d.moved = true;
      cx.notify();
    }
  }
  cancelDrag(cx) {
    if (!this.drag) return;
    this.drag = null;
    this.dropTarget = null;
    cx.notify();
  }
  endDrag(cx, active) {
    const d = this.drag;
    const target = this.dropTarget;
    this.drag = null;
    this.dropTarget = null;
    if (!d?.moved) return;
    this.suppressClick = true;
    if (target === "right" || target === "down") {
      // Show the terminal beside the active pane: take it out of its pane, then give it one here.
      run("terminal.park", { terminal: d.terminal });
      run("terminal.keep", { terminal: d.terminal, place: target });
    } else if (target?.startsWith("tab:") && d.tab) {
      const index = (active?.tabs ?? []).findIndex(t => t.id === target.slice(4));
      if (index >= 0 && target.slice(4) !== d.tab) run("tab.move", { id: d.tab, index: index + 1 });
    }
    cx.notify();
  }
  clickAllowed() {
    if (this.drag?.moved || this.suppressClick) { this.suppressClick = false; return false; }
    return true;
  }
  hoverTarget(key) {
    return (hovered, cx) => {
      if (!this.drag?.moved) return;
      if (hovered) this.dropTarget = key;
      else if (this.dropTarget === key) this.dropTarget = null;
      cx.notify();
    };
  }
  dropZones(C, title) {
    const zone = (key, label, file) => h_flex().id(`drop-${key}`).h(30).px(12).gap(7).items_center().rounded(6).flex_none()
      .border(1).border_dashed().border_color(this.dropTarget === key ? C.accent : C.input)
      .bg(this.dropTarget === key ? wash(C.accent, C) : C.bg).text_size(12)
      .text_color(this.dropTarget === key ? C.accent : C.muted).on_hover(this.hoverTarget(key))
      .child(svg(`mods/${MOD}/icons/${file}.svg`).size(14)).child(label);
    return h_flex().gap(8).items_center().flex_none()
      .when(!!title, el => el.child(div().text_size(11).text_color(C.muted).child(title)))
      .child(zone("right", "Right", "split-right"))
      .child(zone("down", "Below", "split-down"));
  }
  closeSession(a, info, cx) {
    // An agent that has not started work closes at once; one with context asks first.
    if (!info || !info.tokens) {
      run("pane.close", { pane: a.pane });
    } else {
      this.confirming = a.address;
      cx.notify();
    }
  }
  card(C, a, state, info) {
    const old = this.observed[a.address];
    if (!old || old.status !== a.status) this.observed[a.address] = { status: a.status, at: Date.now() };
    const mins = Math.floor((Date.now() - this.observed[a.address].at) / 60000);
    const elapsed = mins ? `${mins}m` : "<1m";
    const confirming = this.confirming === a.address;
    const project = info && projects().find(p => p.folder === info.folder);
    const sid = info?.sid ? info.sid.slice(0, 8) : a.address;
    // The card of the agent shown in the workspace below stands out.
    const border = confirming ? C.danger : a.focused ? C.accent : C.line;
    return v_flex().id(`agent-${a.address}`).w_full().flex_none().px(12).py(10).gap(8).rounded(8)
      .bg(a.focused ? C.bar : C.card).border(1).border_color(border).cursor_pointer()
      .hover(s => s.border_color(confirming ? C.danger : a.focused ? C.accent : state.color))
      .on_click(() => run("agent.focus", { terminal: a.address }))
      .child(h_flex().gap(8).items_center()
        .child(icon(C, a.program, 15))
        .child(div().text_size(12).font_semibold().text_color(C.ink).flex_none().child(info?.model || a.program.name))
        .child(div().id(`sid-${a.address}`).px(4).py(1).rounded(4).font_family("Geist Mono").text_size(11).text_color(C.muted)
          .when(!!info?.sid, el => el.cursor_pointer().hover(s => s.bg(C.selected).text_color(C.ink))
            .tooltip(`Copy ${info.sid}`)
            .on_click((_e, cx) => {
              cx.stop_propagation();
              cx.write_to_clipboard(info.sid);
              notify({ title: "Session id copied", body: info.sid, level: "info", timeout: 2000 });
            }))
          .child(sid))
        .child(div().flex_1())
        .child(xButton(C, `close-${a.address}`, "Close session", (_e, cx) => this.closeSession(a, info, cx))))
      .child(div().text_size(13).font_medium().text_color(C.ink).truncate().child(info?.title || a.tab_name))
      .when(confirming, el => el.child(h_flex().gap(8).items_center().px(8).py(6).rounded(6).bg(wash(C.danger, C))
        .child(div().flex_1().text_size(12).text_color(C.ink).child("End this session?"))
        .child(chip(C, `cancel-${a.address}`, "Cancel", false, (_e, cx) => { cx.stop_propagation(); this.confirming = null; cx.notify(); }))
        .child(h_flex().id(`confirm-${a.address}`).h(28).px(11).items_center().rounded(6).bg(C.danger).cursor_pointer()
          .text_size(11).font_semibold().text_color(C.card).child("Close")
          .on_click((_e, cx) => { cx.stop_propagation(); this.confirming = null; run("pane.close", { pane: a.pane }); }))))
      .child(info
        ? h_flex().gap(8).items_center()
          .child(div().text_size(11).text_color(C.muted).child("Context"))
          .child(div().flex_1().h(5).rounded(5).bg(C.selected).overflow_hidden()
            .child(div().h(5).rounded(5).w(`${Math.min(100, info.ctx)}%`).bg(pctColor(C, info.ctx))))
          .child(div().font_family("Geist Mono").text_size(11).text_color(pctColor(C, info.ctx))
            .child(`${info.ctx}% (${kTokens(info.tokens)})`))
        : div().text_size(11).text_color(C.muted).child("No session data yet. It appears after the first reply."))
      .child(h_flex().gap(8).items_center().text_size(11).text_color(C.muted)
        .child(project
          ? h_flex().flex_1().min_w(0).gap(5).items_center().text_color(C.ink).font_medium().tooltip(tilde(info.folder))
            .child(div().size(7).rounded(2).bg(C.accent).flex_none()).child(div().truncate().child(project.name))
          : div().flex_1().min_w(0).truncate().font_family("Geist Mono").child(info ? tilde(info.folder) : a.space_name))
        .when(!!info, el => el.child(div().font_family("Geist Mono").text_color(C.ink).child(`$${info.cost.toFixed(2)}`)))
        .child(div().flex_none().child(`· ${elapsed}`)));
  }
  header(C, active, list) {
    const f = filter();
    const limits = live().limits;
    const plan = limits.filter(l => !l.group);
    const groups = [...new Set(limits.filter(l => l.group).map(l => l.group))];
    const v = view();
    // Fixed rows from the top: switching views must not move the header.
    return v_flex().size_full().bg(C.bar).px(24).pt(19).gap(12)
      .child(h_flex().items_center().gap(12)
        .child(this.viewSwitch(C))
        .child(div().text_size(18).text_color(C.dim).child("/"))
        .when(v !== "board", el => el.child(this.agentPicker(C)))
        .when(v === "board", el => el.child(h_flex().id("space-picker").h(34).pl(12).pr(10).gap(8).items_center().rounded(7).flex_none()
          .bg(C.bg).border(1).border_color(C.line).cursor_pointer().hover(s => s.border_color(C.input))
          .on_click(() => openOverlay({ mod: MOD, props: { role: "spaces" }, kind: "popup", width: 460,
            height: projectsPopupHeight(), at: { x: PICKER_X, y: 52 } }))
          .child(dot(C.accent, 8))
          .child(div().text_size(16).font_semibold().text_color(C.ink).child(active?.name ?? "No space"))
          .child(div().text_size(11).text_color(C.muted).child("▾"))))
        .child(div().flex_1())
        .when(plan.length > 0, el => el.child(limitPill(C, plan, "", C.ink, C.line)))
        .children(groups.map(g => limitPill(C, limits.filter(l => l.group === g),
          g[0].toUpperCase() + g.slice(1), C.fable, wash(C.fable, C)))))
      .when(v === "board", el => el.child(h_flex().gap(8).items_center()
        .child(chip(C, "chip-projects", this.projectFilterLabel() + "  ▾", !!f.projects,
          () => openOverlay({ mod: MOD, props: { role: "projectfilter" }, kind: "popup", width: 380,
            height: checkListHeight(agentProjects().length), at: { x: 24, y: 96 } })))
        .child(chip(C, "chip-statuses", this.statusFilterLabel() + "  ▾", !!f.statuses,
          () => openOverlay({ mod: MOD, props: { role: "statusfilter" }, kind: "popup", width: 300,
            height: checkListHeight(states().length), at: { x: Math.round(59 + this.projectFilterLabel().length * 5.5), y: 96 } })))
        .child(div().flex_1())
        .child(h_flex().gap(6).items_center().flex_none().text_size(11).text_color(C.muted)
          .child(dot(theme().done, 6)).child(`${list.length} agents across ${agentProjects().length} projects`))
        .child(h_flex().id("new-agent").h(28).px(12).gap(6).items_center().rounded(6).flex_none().bg(C.accent).cursor_pointer()
          .text_size(12).font_semibold().text_color(C.card).hover(s => s.opacity(0.82))
          .tooltip("Start Claude in a new tab of this space")
          .on_click(() => run("tab.new", active
            ? { space: active.id, folder: active.folder, name: "claude", argv: ["claude"] }
            : { name: "claude", argv: ["claude"] }))
          .child("+ Agent"))))
      .when(v === "files", el => el.child(this.filesBar(C)))
      .when(v === "changes", el => el.child(this.changesBar(C)));
  }
  filesBar(C) {
    const g = gitState();
    const hidden = showHidden();
    return h_flex().h(28).gap(10).items_center()
      .child(this.worktreePicker(C))
      .child(div().font_family("Geist Mono").text_size(11).text_color(C.muted).truncate().child(tilde(viewFolder() ?? "")))
      .child(div().flex_1())
      .child(chip(C, "hidden-files", hidden ? "Hidden files: shown" : "Hidden files: off", hidden,
        () => setShared(HIDDEN_KEY, !hidden)))
      .when(g.files.length > 0, el => el.child(h_flex().gap(6).items_center().flex_none().text_size(11).text_color(C.muted)
        .child(dot(theme().blocked, 6)).child(`${g.files.length} changed`)));
  }
  changesBar(C) {
    const g = gitState();
    const add = g.files.reduce((n, f) => n + f.add, 0);
    const del = g.files.reduce((n, f) => n + f.del, 0);
    const num = (text, color) => div().font_family("Geist Mono").text_size(11).text_color(color).flex_none().child(text);
    return h_flex().h(28).gap(10).items_center()
      .child(this.worktreePicker(C))
      .child(div().font_family("Geist Mono").text_size(11).text_color(C.dim).truncate().child(tilde(g.root ?? viewFolder() ?? "")))
      .child(div().flex_1())
      .when(!!g.root, el => el
        .child(chip(C, "group-by-dir", "Group by directory", changeTree(),
          () => setChangeTree(!changeTree())))
        .child(div().text_size(12).text_color(C.muted).flex_none().child(`${g.files.length} file${g.files.length === 1 ? "" : "s"}`))
        .child(num(`+${add}`, theme().done)).child(num(`−${del}`, C.danger)));
  }
  // Changed files grouped by folder. A folder holding only one folder joins it in one row ("apps/extension/src").
  changeTree(files) {
    this.changeCollapsed ??= new Set();
    const node = () => ({ dirs: new Map(), files: [] });
    const root = node();
    for (const f of files) {
      let n = root;
      for (const part of f.path.split("/").slice(0, -1)) {
        if (!n.dirs.has(part)) n.dirs.set(part, node());
        n = n.dirs.get(part);
      }
      n.files.push(f);
    }
    const count = (n) => n.files.length + [...n.dirs.values()].reduce((sum, d) => sum + count(d), 0);
    const rows = [];
    const walk = (n, prefix, depth) => {
      for (const [name, first] of [...n.dirs].sort((x, y) => x[0].localeCompare(y[0]))) {
        let d = first, label = name, path = prefix + name;
        while (d.files.length === 0 && d.dirs.size === 1) {
          const [[next, inner]] = [...d.dirs];
          label += "/" + next;
          path += "/" + next;
          d = inner;
        }
        rows.push({ dir: true, path, label, depth, count: count(d) });
        if (!this.changeCollapsed.has(path)) walk(d, path + "/", depth + 1);
      }
      for (const f of [...n.files].sort((x, y) => x.path.localeCompare(y.path))) rows.push({ dir: false, file: f, depth });
    };
    walk(root, "", 0);
    return rows;
  }
  // Branch of the shown folder; with more than one worktree it opens a list of them.
  worktreePicker(C) {
    const g = gitState();
    if (!g.root) return div().flex_none();
    const many = g.worktrees.length > 1;
    return h_flex().id("worktree-picker").h(28).px(10).gap(6).items_center().rounded(6).flex_none()
      .bg(C.card).border(1).border_color(C.line).font_family("Geist Mono").text_size(11).text_color(C.ink)
      .when(many, el => el.cursor_pointer().hover(s => s.border_color(C.input)).tooltip("Switch worktree")
        .on_click(() => openOverlay({ mod: MOD, props: { role: "worktrees" }, kind: "popup", width: 520,
          height: worktreesPopupHeight(), at: { x: 24, y: 96 } })))
      .child(svg(`mods/${MOD}/icons/branch.svg`).size(12).text_color(C.muted))
      .child(g.branch || "detached")
      .when(many, el => el.child(div().font_family("Geist").text_color(C.muted).child(`${g.worktrees.length} worktrees ▾`)));
  }
  worktreesPopup(C) {
    const overlay = props().overlay;
    const a = targetAgent();
    const g = gitState();
    const own = agentFolder(a);
    const q = (this.wtSearch?.value() ?? "").trim().toLowerCase();
    const shown = g.worktrees.filter(w => !q || w.branch.toLowerCase().includes(q) || w.path.toLowerCase().includes(q));
    return v_flex().w_full().h(worktreesPopupHeight()).p(6).gap(2).bg(C.bg).text_color(C.ink)
      .child(h_flex().flex_none().px(10).pt(6).pb(2).items_center().text_size(10).text_color(C.muted)
        .child(div().flex_1().child("WORKTREES")).child(q ? `${shown.length} of ${g.worktrees.length}` : String(g.worktrees.length)))
      .when(!!this.wtSearch, el => el.child(searchField(C, this.wtSearch)))
      .child(v_flex().id("worktree-list").flex_1().min_h(0).overflow_y_scrollbar().gap(2)
      .when(shown.length === 0, el => el.child(div().px(10).py(12).text_size(12).text_color(C.muted).child("No worktree matches.")))
      .children(shown.map(w => {
        const selected = w.path === g.root;
        return h_flex().id(`wt-${w.path}`).h(48).flex_none().px(10).gap(10).items_center().rounded(6).cursor_pointer()
          .bg(selected ? C.selected : C.bg).hover(s => s.bg(C.selected))
          .on_click(() => {
            // Back to the agent's own worktree drops the pick.
            const mine = own && (own === w.path || own.startsWith(w.path + "/"));
            setShared(WORKTREE_KEY, mine || !a ? null : { address: a.address, path: w.path });
            closeOverlay(overlay);
          })
          .child(svg(`mods/${MOD}/icons/branch.svg`).size(13).text_color(C.accent).flex_none())
          .child(v_flex().flex_1().min_w(0).gap(2)
            .child(div().font_family("Geist Mono").text_size(12).font_semibold().child(w.branch || "detached"))
            .child(div().font_family("Geist Mono").text_size(11).text_color(C.muted).truncate().child(tilde(w.path))))
          .when(!!own && (own === w.path || own.startsWith(w.path + "/")), el => el.child(div().text_size(10).text_color(C.accent).flex_none().child("AGENT")))
          .when(selected, el => el.child(div().text_size(13).text_color(C.accent).child("✓")));
      })));
  }
  viewSwitch(C) {
    const v = view();
    const changed = gitState().files.length;
    // The count sits on the corner of Changes, partly over the word, so the switch never changes width.
    const tab = (key, label, file) => h_flex().id(`view-${key}`).relative().h(28).pl(12).pr(key === "changes" ? 16 : 12)
      .gap(6).items_center().rounded(5)
      .bg(v === key ? C.selected : C.bg).text_size(12).font_medium().text_color(v === key ? C.accent : C.muted)
      .cursor_pointer().hover(s => s.text_color(v === key ? C.accent : C.ink))
      .on_click(() => setShared(VIEW_KEY, key))
      .child(svg(`mods/${MOD}/icons/${file}.svg`).size(13)).child(label)
      .when(key === "changes" && changed > 0, el => el.child(div().absolute().top(1).right(2).h(13).px(3).rounded(7)
        .flex().items_center().bg(wash(theme().blocked, C, "40")).font_family("Geist Mono").text_size(9).font_semibold()
        .text_color(theme().blocked).child(changed > 99 ? "99+" : String(changed))));
    return h_flex().p(3).gap(2).items_center().rounded(8).bg(C.bg).border(1).border_color(C.line).flex_none()
      .child(tab("board", "Board", "view-board"))
      .child(tab("files", "Files", "folder"))
      .child(tab("changes", "Changes", "branch"));
  }
  projectFilterLabel() {
    const picked = filter().projects;
    if (!picked) return "All projects";
    const names = agentProjects().filter(r => picked.includes(r.folder)).map(r => r.name);
    return names.length === 0 ? "No projects" : names.length === 1 ? names[0] : `${names.length} projects`;
  }
  statusFilterLabel() {
    const picked = filter().statuses;
    if (!picked) return "All statuses";
    const names = states().filter(s => picked.includes(s.key)).map(s => s.label);
    return names.length === 0 ? "No statuses" : names.length === 1 ? names[0] : `${names.length} statuses`;
  }
  projectFilterPopup(C) {
    return this.checkList(C, "PROJECTS WITH AGENTS", "projects",
      agentProjects().map(r => ({ key: r.folder, name: r.name, sub: tilde(r.folder) || "~", count: r.agents.length })));
  }
  statusFilterPopup(C) {
    const all = agents();
    return this.checkList(C, "STATUSES", "statuses", states().map(s => ({ key: s.key, name: s.label, color: s.color,
      count: all.filter(a => a.status === s.key).length })));
  }
  // A filter list with a checkbox per item. Checking every item goes back to "all", so new items show too.
  checkList(C, title, field, list) {
    const picked = filter()[field];
    const on = (key) => !picked || picked.includes(key);
    const allOn = list.every(i => on(i.key));
    const box = (checked) => div().size(16).flex().flex_none().items_center().justify_center().rounded(4)
      .border(1).border_color(checked ? C.accent : C.input).bg(checked ? C.accent : C.card)
      .text_size(11).text_color(C.card).child(checked ? "✓" : "");
    const row = (id, onClick) => h_flex().id(id).flex_none().h(44).px(10).gap(10).items_center().rounded(6).cursor_pointer()
      .hover(st => st.bg(C.selected)).on_click(onClick);
    const toggle = (key) => {
      const next = list.map(i => i.key).filter(x => x === key ? !on(x) : on(x));
      setFilter({ [field]: next.length === list.length ? null : next });
    };
    return v_flex().w_full().h(checkListHeight(list.length)).p(6).gap(2).bg(C.bg).text_color(C.ink)
      .child(div().flex_none().px(10).pt(6).pb(4).text_size(10).text_color(C.muted).child(title))
      .child(row(`${field}-all`, () => setFilter({ [field]: allOn ? [] : null }))
        .child(box(allOn)).child(div().flex_1().text_size(13).font_semibold().child("Select all")))
      .child(div().flex_none().h(1).mx(4).my(2).bg(C.line))
      .child(v_flex().id(`${field}-list`).flex_1().min_h(0).overflow_y_scrollbar().gap(2)
        .children(list.map(i => row(`${field}-${i.key}`, () => toggle(i.key))
          .child(box(on(i.key)))
          .when(!!i.color, el => el.child(dot(i.color, 8)))
          .child(v_flex().flex_1().min_w(0)
            .child(div().text_size(13).font_semibold().truncate().child(i.name))
            .when(!!i.sub, el => el.child(div().font_family("Geist Mono").text_size(11).text_color(C.muted).truncate().child(i.sub))))
          .child(div().flex_none().text_size(11).text_color(C.muted).child(`${i.count} agent${i.count === 1 ? "" : "s"}`)))));
  }
  agentLabel(a) {
    const info = live().sessions[a.address];
    const folder = agentFolder(a);
    const project = folder && projects().find(p => p.folder === folder);
    return { info, model: info?.model || a.program.name, sid: info?.sid ? info.sid.slice(0, 8) : a.address,
      place: project?.name ?? (folder ? baseName(folder) : a.space_name) };
  }
  agentPicker(C) {
    const a = targetAgent();
    const l = a && this.agentLabel(a);
    const n = agents().length;
    return h_flex().id("agent-picker").h(34).pl(12).pr(10).gap(8).items_center().rounded(7).flex_none()
      .bg(C.bg).border(1).border_color(C.line).cursor_pointer().hover(s => s.border_color(C.input)).tooltip("Pick an agent")
      .on_click(() => openOverlay({ mod: MOD, props: { role: "agents" }, kind: "popup", width: 520,
        height: 40 + Math.max(1, n) * 73 + 46, at: { x: PICKER_X, y: 52 } }))
      .child(dot(a ? states().find(s => s.key === a.status)?.color ?? C.dim : C.dim, 8))
      .when(!!a, el => el
        .child(div().text_size(15).font_semibold().text_color(C.ink).child(l.model))
        .child(div().font_family("Geist Mono").text_size(12).text_color(C.muted).child(l.sid))
        .child(div().text_color(C.dim).child("·"))
        .child(div().text_size(14).font_medium().text_color(C.ink).child(l.place)))
      .when(!a, el => el.child(div().text_size(14).text_color(C.muted).child("No agents")))
      .child(div().text_size(11).text_color(C.muted).child("▾"));
  }
  agentsPopup(C) {
    const overlay = props().overlay;
    const current = targetAgent();
    return v_flex().size_full().p(6).gap(2).bg(C.bg).text_color(C.ink)
      .child(div().px(10).pt(6).pb(2).text_size(10).text_color(C.muted).child("ACTIVE AGENTS"))
      // A thin line between agents, so the rows don't run together.
      .children(agents().flatMap((a, i) => {
        const l = this.agentLabel(a);
        const st = states().find(s => s.key === a.status);
        const selected = current?.address === a.address;
        const line = div().flex_none().h(1).mx(10).bg(C.line);
        const row = h_flex().id(`pick-${a.address}`).flex_none().h(66).px(10).gap(10).items_center().rounded(6).cursor_pointer()
          .bg(selected ? C.selected : C.bg).hover(s => s.bg(C.selected))
          .on_click(() => {
            setShared(TARGET_KEY, { address: a.address, focus: a.address });
            run("agent.focus", { terminal: a.address });
            closeOverlay(overlay);
          })
          .child(dot(st?.color ?? C.dim, 8))
          .child(v_flex().flex_1().min_w(0).gap(2)
            .child(h_flex().gap(8).items_center()
              .child(div().text_size(13).font_semibold().child(l.model))
              .child(div().font_family("Geist Mono").text_size(11).text_color(C.muted).child(l.sid))
              .child(div().text_size(11).text_color(st?.color ?? C.muted).child(st?.label ?? "")))
            .child(div().text_size(12).text_color(C.ink).truncate().child(l.info?.title || a.tab_name))
            .child(h_flex().gap(6).items_center().text_size(11).text_color(C.muted)
              .child(svg(`mods/${MOD}/icons/folder.svg`).size(11).text_color(C.accent))
              .child(div().text_color(C.ink).truncate().child(l.place))
              .child(div().flex_none().child(`· space ${a.space_name}`))))
          .when(!!l.info, el => el.child(div().font_family("Geist Mono").text_size(11)
            .text_color(pctColor(C, l.info.ctx)).child(`${l.info.ctx}%`)))
          .when(selected, el => el.child(div().text_size(13).text_color(C.accent).child("✓")));
        return i ? [line, row] : [row];
      }))
      .child(div().h(1).mx(4).my(4).bg(C.line))
      .child(div().px(10).pb(4).text_size(11).text_color(C.muted)
        .child("Picking an agent also focuses its terminal below."));
  }
  // One list of projects. A row goes to its agent, else to its open space, else opens a space with Claude.
  spacesPopup(C) {
    const overlay = props().overlay;
    const active = spaces().find(s => s.active);
    const row = (id, onClick) => h_flex().id(id).flex_none().gap(10).items_center().px(10).py(8).rounded(6).cursor_pointer()
      .hover(st => st.bg(C.selected)).on_click(onClick);
    const details = (name, folder) => v_flex().flex_1().min_w(0).gap(2)
      .child(div().text_size(13).font_semibold().truncate().child(name))
      .child(div().font_family("Geist Mono").text_size(11).text_color(C.muted).truncate().child(tilde(folder) || "~"));
    const q = (this.spaceSearch?.value() ?? "").trim().toLowerCase();
    const rows = projectRows(agents()).filter(r => matches(q, r.name, r.folder, tilde(r.folder), r.space?.name));
    return v_flex().w_full().h(projectsPopupHeight()).p(6).gap(2).bg(C.bg).text_color(C.ink)
      .when(!!this.spaceSearch, el => el.child(searchField(C, this.spaceSearch).mt(4)))
      .child(v_flex().id("project-list").flex_1().min_h(0).overflow_y_scrollbar().gap(2)
        .child(div().px(10).pt(6).pb(2).text_size(10).text_color(C.muted).child("PROJECTS"))
        .children(rows.map(r => {
          const n = r.agents.length;
          return row(`project-${r.folder}`, () => {
            if (n) run("agent.focus", { terminal: r.agents[0].address });
            else if (r.space) run("space.select", { id: r.space.id });
            else openProject(r);
            closeOverlay(overlay);
          })
            .when(!!active && r.space?.id === active.id, el => el.bg(C.selected))
            .tooltip(n ? "Go to its agent" : r.space ? "Go to its space" : "Open a space here and start Claude")
            .child(n
              ? dot(states().find(x => x.key === r.agents[0].status)?.color ?? C.dim, 8)
              : r.space ? dot(C.dim, 8) : div().size(8).rounded(2).bg(C.accent).flex_none())
            .child(details(r.name, r.folder))
            .child(div().text_size(11).text_color(C.muted).flex_none()
              .child(n ? `${n} agent${n > 1 ? "s" : ""}` : r.space ? "open" : "not open"))
            .when(r.saved && !n && !r.space,
              el => el.child(xButton(C, `remove-${r.folder}`, "Remove project", () => removeProject(r.folder), 20)))
            .when(!r.saved, el => el.child(chip(C, `save-${r.folder}`, "Save", false, (_e, cx) => {
              cx.stop_propagation();
              setShared(PROJECTS_KEY, [...projects(), { name: r.name, folder: r.folder }]);
            })));
        }))
        .when(!rows.length, el => el.child(div().px(10).py(12).text_size(12).text_color(C.muted).child("Nothing matches."))))
      .child(div().h(1).mx(4).my(6).bg(C.line))
      .child(row("project-add", (_e, cx) => cx.spawn(async () => {
        const folders = await pickFolders();
        closeOverlay(overlay);
        if (!folders.length) return;
        const known = new Set(projects().map(p => p.folder));
        const added = folders.filter(f => !known.has(f)).map(folder => ({ name: baseName(folder), folder }));
        if (added.length) setShared(PROJECTS_KEY, [...projects(), ...added]);
        // One folder opens at once; several are only saved, to open from this list.
        if (folders.length === 1) openProject({ name: baseName(folders[0]), folder: folders[0] });
        else notify({ title: `Added ${added.length} project${added.length === 1 ? "" : "s"}`,
          body: "Open them from the project list.", level: "info", timeout: 3000 });
      }))
        .text_size(12).text_color(C.muted).hover(st => st.text_color(C.ink))
        .child("+").child("Add projects… (one opens a space with Claude)"));
  }
  // Inline tab rename in a terminal chip: Enter or leaving the field saves, an empty name keeps the old one.
  startRename(tab, old, cx) {
    this.finishRename(false, cx);
    const state = InputState.new({ value: old, placeholder: "Tab name" });
    state.on("submit", (_e, cx) => this.finishRename(true, cx));
    state.on("blur", (_e, cx) => this.finishRename(true, cx));
    this.renaming = { tab, old, state };
    state.focus();
    cx.notify();
  }
  finishRename(save, cx) {
    const r = this.renaming;
    if (!r) return;
    this.renaming = null;
    const name = r.state.value().trim();
    if (save && name && name !== r.old) run("tab.rename", { id: r.tab, name });
    cx.notify();
  }
  rail(C, active) {
    const tabIds = new Set((active?.tabs ?? []).map(t => t.id));
    // Plain shells only: a terminal that runs an agent is shown as a card instead.
    const shells = panes().filter(p => p.terminal && tabIds.has(p.tab) && !p.status);
    const focusedPane = panes().find(p => p.focused)?.pane;
    const tabName = (id) => active?.tabs.find(t => t.id === id)?.name ?? "";
    const dragging = this.drag?.moved;
    // The bar keeps the keyboard itself: a press on it must not hand focus to a terminal.
    return h_flex().id("rail-root").size_full().pl(14).pr(6).gap(10).items_center().bg(C.bar).rounded(7)
      .when(!!this.railFocus, el => el.track_focus(this.railFocus))
      .on_mouse_down("left", (_e, cx) => { this.railFocus?.focus(); cx.stop_propagation(); })
      .on_mouse_move((e, cx) => this.moveDrag(e, cx))
      .on_mouse_up("left", (_e, cx) => this.endDrag(cx, active))
      .on_hover((hovered, cx) => { if (!hovered) this.cancelDrag(cx); })
      .child(div().flex_none().text_size(12).font_semibold().text_color(C.ink).child("Live workspace"))
      .child(div().flex_none().text_size(11).text_color(C.muted).child(active?.name ?? ""))
      .child(div().w(1).h(18).bg(C.line).flex_none())
      .child(h_flex().id("shells").flex_1().min_w(0).gap(6).items_center().overflow_x_scroll()
        .children(shells.map(p => {
          const selected = p.pane === focusedPane;
          const isTarget = this.dropTarget === `tab:${p.tab}`;
          const isDragged = dragging && this.drag.pane === p.pane;
          return h_flex().id(`shell-${p.pane}`).h(28).pl(10).pr(3).gap(7).items_center().rounded(6).flex_none()
            .bg(selected ? C.selected : C.bg).border(1)
            .border_color(isTarget ? C.accent : selected ? C.input : C.line)
            .when(isDragged, el => el.opacity(0.5).cursor_grabbing())
            .when(!isDragged, el => el.cursor_pointer())
            .hover(s => s.border_color(C.input)).tooltip(`${p.program?.name ?? "Terminal"} · drag to move · double-click to rename`)
            .on_hover(this.hoverTarget(`tab:${p.tab}`))
            .on_mouse_down("left", (e) => {
              if (this.renaming?.tab !== p.tab) this.startDrag({ kind: "shell", terminal: p.terminal, pane: p.pane, tab: p.tab }, e);
            })
            .on_click((e, cx) => {
              if (this.renaming?.tab === p.tab || !this.clickAllowed()) return;
              if (e.click_count >= 2) { this.startRename(p.tab, tabName(p.tab), cx); return; }
              run("tab.select", { id: p.tab });
              run("pane.focus", { pane: p.pane });
            })
            .child(icon(C, p.program, 13))
            .child(this.renaming?.tab === p.tab
              ? div().w(140).text_size(12).child(Input.new(this.renaming.state))
              : div().text_size(12).text_color(C.ink).child(tabName(p.tab) || p.program?.name || "Terminal"))
            .child(xButton(C, `shell-close-${p.pane}`, "Close terminal", () => run("pane.close", { pane: p.pane }), 20));
        })))
      .when(!!dragging, el => el.child(this.dropZones(C, "")))
      .when(!dragging, el => el
        .child(div().flex_none().text_size(11).text_color(C.muted).child(`${shells.length} terminal${shells.length === 1 ? "" : "s"}`)))
      .child(h_flex().id("new-terminal").h(28).px(12).gap(6).items_center().rounded(6).flex_none().bg(C.accent).cursor_pointer()
        .text_size(12).font_semibold().text_color(C.card).hover(s => s.opacity(0.82))
        .tooltip("Open a shell in a new tab of this space")
        .on_click(() => run("tab.new", active ? { space: active.id } : {}))
        .child("+ Terminal"));
  }
  paneHeader(C) {
    const p = panes().find(p => p.pane === props().pane);
    const info = p?.terminal ? live().sessions[p.terminal] : null;
    return h_flex().size_full().px(12).items_center().gap(8).bg(C.bar).border_b(1).border_color(C.line)
      .child(dot(states().find(s => s.key === p?.status)?.color ?? C.dim, 7))
      .child(icon(C, p?.program, 14))
      .child(div().text_size(12).font_semibold().text_color(C.ink).child(info?.model || p?.program?.name || "Terminal"))
      .child(div().font_family("Geist Mono").text_size(11).text_color(C.muted).child(info?.sid ? info.sid.slice(0, 8) : p?.terminal ?? ""))
      .child(div().flex_1())
      .when(!!info, el => el.child(h_flex().gap(6).items_center().font_family("Geist Mono").text_size(11).mr(4)
        .child(div().text_color(pctColor(C, info.ctx)).child(`${info.ctx}% (${kTokens(info.tokens)})`))
        .child(div().text_color(C.dim).child("·"))
        .child(div().text_color(C.muted).child(`$${info.cost.toFixed(2)}`))))
      .when(!!p, el => el
        .child(iconButton(C, `split-right-${p.pane}`, "Split right: a new terminal beside", "split-right",
          () => run("pane.split", { pane: p.pane, direction: "right" })))
        .child(iconButton(C, `split-down-${p.pane}`, "Split down: a new terminal below", "split-down",
          () => run("pane.split", { pane: p.pane, direction: "down" })))
        .child(xButton(C, `pane-close-${p.pane}`, "Close pane", () => run("pane.close", { pane: p.pane }), 22, 17)));
  }
  panel(C) {
    return v_flex().min_w(0).min_h(0).rounded(8).overflow_hidden().bg(C.card).border(1).border_color(C.line);
  }
  panelHeader(C, path, extra) {
    const root = this.folder ?? gitState().root;
    const parts = relPath(root, path).split("/");
    return h_flex().h(34).flex_none().pl(12).pr(6).gap(8).items_center().bg(C.bar).border_b(1).border_color(C.line)
      .when(parts.length > 1, el => el.child(div().font_family("Geist Mono").text_size(11).text_color(C.muted).truncate()
        .child(parts.slice(0, -1).join(" / ") + " /")))
      .child(div().text_size(12).font_semibold().text_color(C.ink).flex_none().child(parts[parts.length - 1]))
      .children(extra)
      .child(div().flex_1());
  }
  toolButton(C, id, label, file, tip, onClick) {
    return h_flex().id(id).h(24).px(8).gap(5).items_center().rounded(5).flex_none().text_size(12).text_color(C.muted)
      .cursor_pointer().hover(s => s.bg(C.selected).text_color(C.ink)).tooltip(tip).on_click(onClick)
      .when(!!file, el => el.child(svg(`mods/${MOD}/icons/${file}.svg`).size(12))).child(label);
  }
  copyPath(path) {
    return (_e, cx) => {
      cx.write_to_clipboard(path);
    };
  }
  empty(C, text) {
    return v_flex().size_full().items_center().justify_center().text_size(13).text_color(C.muted).child(text);
  }
  treeRows() {
    const rows = [];
    const walk = (dir, depth) => {
      for (const e of this.dirs[dir] ?? []) {
        if (e.name === ".git" || (!showHidden() && e.name.startsWith("."))) continue;
        const path = `${dir}/${e.name}`;
        rows.push({ path, name: e.name, dir: e.dir, depth });
        if (e.dir && this.expanded.has(path)) walk(path, depth + 1);
      }
    };
    if (this.folder) walk(this.folder, 0);
    return rows;
  }
  filesView(C) {
    if (!this.folder) return this.empty(C, "No agent folder yet. Focus an agent, or pick one above.");
    const g = gitState();
    const marks = {};
    if (g.root) for (const f of g.files) marks[`${g.root}/${f.path}`] = f.mark;
    const rows = this.treeRows();
    const file = this.file;
    const tree = this.panel(C).size_full().p(6).when(!!this.treeFocus, el => el.track_focus(this.treeFocus))
      .when(rows.length === 0, el => el.child(div().p(8).text_size(12).text_color(C.muted)
        .child(this.dirError ? `Can't read the folder: ${this.dirError}` : this.dirs[this.folder] ? "Empty folder." : "Loading…")))
      .child(v_flex().id("tree").flex_1().min_h(0).overflow_y_scrollbar().gap(1).children(rows.map(r => {
        const selected = (this.treeSel ?? file?.path) === r.path;
        const mark = marks[r.path];
        return h_flex().id(`row-${r.path}`).h(24).flex_none().pl(8 + r.depth * 16).pr(8).gap(6).items_center().rounded(5)
          .bg(selected ? theme().selection ?? C.selected : C.card).hover(s => s.bg(selected ? theme().selection ?? C.selected : C.bar))
          .cursor_pointer().text_size(12).text_color(mark === "D" ? C.dim : C.ink)
          .on_click((_e, cx) => {
            this.treeSel = r.path;
            this.treeFocus?.focus();
            r.dir ? this.toggleDir(r.path, cx) : this.openFile(r.path, cx);
          })
          .on_mouse_down("right", (e, cx) => {
            this.treeSel = r.path;
            this.openPathMenu(e, r.path, cx);
          })
          .child(r.dir
            ? svg(`mods/${MOD}/icons/${this.expanded.has(r.path) ? "chevron-down" : "chevron-right"}.svg`).size(11).text_color(C.dim).flex_none()
            : div().size(11).flex_none())
          .child(svg(`mods/${MOD}/icons/${r.dir ? "folder" : "file"}.svg`).size(13).text_color(r.dir ? C.accent : C.muted).flex_none())
          .child(div().flex_1().min_w(0).truncate().child(r.name))
          .when(!!mark, el => el.child(div().font_family("Geist Mono").text_size(10).font_semibold().text_color(markColor(mark)).child(mark)));
      })));
    const body = [];
    if (!file) {
      body.push(this.empty(C, "Pick a file in the tree."));
    } else {
      const mark = marks[file.path];
      body.push(this.panelHeader(C, file.path, [
        mark ? badge(mark) : null,
        file.lines ? div().text_size(11).text_color(C.muted).flex_none()
          .child(`${file.lines.length} lines · ${(file.size / 1024).toFixed(1)} KB`) : null,
      ].filter(Boolean))
        .when(!!mark && !!g.root, el => el.child(this.toolButton(C, "view-diff", "View diff", null, "Show the diff in Changes",
          () => { this.changeSel = relPath(g.root, file.path); setShared(VIEW_KEY, "changes"); })))
        .child(this.toolButton(C, "copy-path", "Copy path", "copy", "Copy the full path", this.copyPath(file.path)))
        .child(this.toolButton(C, "open-file", "Open", "external", "Open in the default app",
          () => exec("open", [file.path]).catch(() => {}))));
      const lines = file.lines;
      body.push(lines && this.editor
        ? div().flex_1().min_h(0).py(4).on_mouse_down("left", (_e, cx) => cx.stop_propagation()).child(Editor.new(this.editor).size_full())
        : this.empty(C, file.note));
    }
    return this.pathKeys(v_flex().size_full().px(24).pt(14).pb(16).bg(C.bg), () => this.treeSel ?? file?.path)
      .child(this.split("files", tree, this.panel(C).size_full().children(body)));
  }
  // The side panel and the main one with a draggable divider. Each agent keeps its own width.
  split(kind, side, main) {
    const key = targetAgent()?.address ?? "none";
    const saved = (shared(WIDTHS_KEY) ?? {})[key]?.[kind];
    return h_resizable(`${kind}-${key}`).flex_1().min_h(0)
      .on_resize((sizes) => {
        const all = shared(WIDTHS_KEY) ?? {};
        setShared(WIDTHS_KEY, { ...all, [key]: { ...all[key], [kind]: Math.round(sizes[0]) } });
      })
      .child(resizable_panel().size(saved ?? SIDE_WIDTH[kind]).size_range(180, 900).child(div().size_full().pr(6).child(side)))
      .child(resizable_panel().child(div().size_full().pl(6).child(main)));
  }
  // Copy-path chords work while the view holds the keyboard; target() names the picked path.
  pathKeys(el, target) {
    return el.key_context("CorralPaths")
      .on_action("corral-copy-relative", (_e, cx) => target() && copyText(cx, relPath(this.projectRoot(), target())))
      .on_action("corral-copy-absolute", (_e, cx) => target() && copyText(cx, target()));
  }
  openPathMenu(e, path, cx) {
    this.treeFocus?.focus();
    cx.notify();
    openOverlay({ mod: MOD, props: { role: "pathmenu", path, root: this.projectRoot() }, kind: "popup",
      width: 280, height: 92, at: { x: Math.round(e.position.x), y: Math.round(e.position.y) } });
  }
  // Relative paths start at the repository root, or at the agent folder outside git.
  projectRoot() {
    return gitState().root ?? this.folder;
  }
  pathMenu(C) {
    const { path, root, overlay } = props();
    const item = (id, label, keys, text) => h_flex().id(id).h(36).px(10).gap(10).items_center().rounded(6).cursor_pointer()
      .hover(st => st.bg(C.selected))
      .on_click((_e, cx) => { copyText(cx, text); closeOverlay(overlay); })
      .child(svg(`mods/${MOD}/icons/copy.svg`).size(13).text_color(C.muted).flex_none())
      .child(div().flex_1().text_size(13).child(label))
      .child(div().flex_none().font_family("Geist Mono").text_size(11).text_color(C.muted).child(keys));
    return v_flex().w_full().h(92).p(6).gap(2).bg(C.bg).text_color(C.ink)
      .child(item("copy-relative", "Copy relative path", copyKeys().relLabel, relPath(root, path)))
      .child(item("copy-absolute", "Copy absolute path", copyKeys().absLabel, path));
  }
  changesView(C) {
    const g = gitState();
    if (!this.folder) return this.empty(C, "No agent folder yet. Focus an agent, or pick one above.");
    if (!g.root) return this.empty(C, `${tilde(this.folder)} is not a git repository.`);
    const sel = g.files.find(f => f.path === this.changeSel) ?? g.files[0];
    const num = (text, color) => div().font_family("Geist Mono").text_size(11).text_color(color).flex_none().child(text);
    const asTree = changeTree();
    const pick = (path) => (_e, cx) => { this.changeSel = path; this.treeFocus?.focus(); this.loadDiff(cx); cx.notify(); };
    const menu = (path, abs) => (e, cx) => {
      if (path) { this.changeSel = path; this.loadDiff(cx); }
      this.openPathMenu(e, abs, cx);
    };
    const fileRow = (f, depth) => {
      const current = sel?.path === f.path;
      const parts = f.path.split("/");
      return h_flex().id(`change-${f.path}`).h(asTree ? 26 : 40).flex_none().pl(8 + depth * 16).pr(8).gap(8).items_center()
        .rounded(5).cursor_pointer()
        .bg(current ? theme().selection ?? C.selected : C.card).hover(s => s.bg(current ? theme().selection ?? C.selected : C.bar))
        .on_click(pick(f.path))
        .on_mouse_down("right", menu(f.path, `${g.root}/${f.path}`))
        .child(div().w(18).flex_none().text_center().font_family("Geist Mono").text_size(11).font_semibold()
          .text_color(markColor(f.mark)).child(f.mark))
        .child(v_flex().flex_1().min_w(0)
          .child(div().text_size(12).font_medium().text_color(C.ink).truncate().child(parts[parts.length - 1]))
          .when(!asTree, el => el.child(div().font_family("Geist Mono").text_size(10).text_color(C.muted).truncate()
            .child(parts.slice(0, -1).join("/") || "."))))
        .child(num(`+${f.add}`, theme().done))
        .when(f.del > 0, el => el.child(num(`−${f.del}`, C.danger)));
    };
    const dirRow = (r) => h_flex().id(`change-dir-${r.path}`).h(26).flex_none().pl(8 + r.depth * 16).pr(8).gap(6).items_center()
      .rounded(5).cursor_pointer().hover(s => s.bg(C.bar)).text_size(12)
      .on_click((_e, cx) => {
        this.changeCollapsed.has(r.path) ? this.changeCollapsed.delete(r.path) : this.changeCollapsed.add(r.path);
        cx.notify();
      })
      .on_mouse_down("right", menu(null, `${g.root}/${r.path}`))
      .child(svg(`mods/${MOD}/icons/${this.changeCollapsed.has(r.path) ? "chevron-right" : "chevron-down"}.svg`)
        .size(11).text_color(C.dim).flex_none())
      .child(svg(`mods/${MOD}/icons/folder.svg`).size(13).text_color(C.accent).flex_none())
      .child(div().flex_shrink(1).min_w(0).truncate().text_color(C.ink).child(r.label))
      .child(div().flex_none().text_size(11).text_color(C.muted).child(`${r.count} file${r.count === 1 ? "" : "s"}`));
    const list = this.panel(C).size_full().p(6).gap(1).when(!!this.treeFocus, el => el.track_focus(this.treeFocus))
      .child(v_flex().id("changed-files").flex_1().min_h(0).overflow_y_scrollbar().gap(1)
        .children(asTree
          ? this.changeTree(g.files).map(r => r.dir ? dirRow(r) : fileRow(r.file, r.depth))
          : g.files.map(f => fileRow(f, 0))));
    const body = [];
    if (!sel) {
      body.push(this.empty(C, "No uncommitted changes."));
    } else {
      const abs = `${g.root}/${sel.path}`;
      body.push(this.panelHeader(C, abs, [num(`+${sel.add}`, theme().done), sel.del ? num(`−${sel.del}`, C.danger) : null].filter(Boolean))
        .when(sel.mark !== "D", el => el.child(this.toolButton(C, "view-file", "View file", null, "Show the whole file in Files",
          (_e, cx) => this.revealFile(abs, cx))))
        .child(this.toolButton(C, "copy-diff-path", "Copy path", "copy", "Copy the full path", this.copyPath(abs))));
      const lines = this.diff?.path === sel.path ? this.diff.lines : null;
      const kinds = {
        hunk: { bg: wash(C.accent, C, "14"), color: C.accent, sign: "" },
        ctx: { bg: C.card, color: C.ink, sign: "" },
        add: { bg: wash(theme().done, C, "1f"), color: C.ink, sign: "+" },
        del: { bg: wash(C.danger, C, "1f"), color: C.ink, sign: "−" },
      };
      const gutter = (text) => div().w(40).flex_none().pr(6).text_right().text_color(theme().unknown ?? C.dim).child(String(text));
      body.push(lines
        ? uniform_list("diff", lines.length, i => String(i), (range) => lines.slice(range.start, range.end).map(d => {
          const k = kinds[d.kind];
          return h_flex().h(ROW_H).bg(k.bg).font_family("Geist Mono").text_size(12)
            .child(gutter(d.old)).child(gutter(d.now))
            .child(div().w(16).flex_none().text_center().text_color(k.color).child(k.sign))
            .child(div().flex_1().min_w(0).pr(14).whitespace_nowrap().overflow_hidden().text_color(k.color).child(d.text || " "));
        })).flex_1().py(6)
        : this.empty(C, "Loading…"));
    }
    return this.pathKeys(v_flex().size_full().px(24).pt(14).pb(16).bg(C.bg), () => sel && `${g.root}/${sel.path}`)
      .child(this.split("changes", list, this.panel(C).size_full().children(body)));
  }
  // The header and the main area keep the keyboard themselves: a press on them must not hand focus to a terminal.
  render() {
    const el = this.renderView();
    if (!this.selfFocus) return el;
    return el.track_focus(this.selfFocus).on_mouse_down("left", (_e, cx) => { this.selfFocus.focus(); cx.stop_propagation(); });
  }
  renderView() {
    const C = palette();
    const STATES = states();
    const role = props()?.role;
    const active = spaces().find(s => s.active);
    if (role === "header") return this.header(C, active, agents());
    if (role === "spaces") return this.spacesPopup(C);
    if (role === "terminals") return this.rail(C, active);
    if (role === "pane") return this.paneHeader(C);
    if (role === "agents") return this.agentsPopup(C);
    if (role === "worktrees") return this.worktreesPopup(C);
    if (role === "projectfilter") return this.projectFilterPopup(C);
    if (role === "statusfilter") return this.statusFilterPopup(C);
    if (role === "pathmenu") return this.pathMenu(C);
    if (view() === "files") return this.filesView(C);
    if (view() === "changes") return this.changesView(C);
    const list = visibleAgents(active);
    const sessions = live().sessions;
    setAgentOrder(STATES.flatMap(s => list.filter(a => a.status === s.key).map(a => a.address)));
    return h_flex().size_full().px(24).py(16).gap(16).bg(C.bg).children(shownStates().map(state => {
      const cards = list.filter(a => a.status === state.key);
      return v_flex().flex_1().min_w(0).h_full().gap(10)
        .child(h_flex().h(26).flex_none().items_center().gap(8).px(2)
          .child(dot(state.color, 8)).child(div().text_size(13).font_semibold().text_color(C.ink).child(state.label))
          .child(div().px(6).py(1).rounded(4).bg(wash(state.color, C)).text_size(11).text_color(state.color).child(String(cards.length))))
        .child(v_flex().id(`column-${state.key}`).flex_1().min_h(0).overflow_y_scrollbar().gap(10)
          .children(cards.map(a => this.card(C, a, state, sessions[a.address]))));
    }));
  }
}
