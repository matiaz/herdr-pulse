import { execFile } from "node:child_process";
import path from "node:path";
import { GIT_FLAGS, gitEnv } from "./git-safety.mjs";

const HERDR = process.env.HERDR_BIN_PATH || "herdr";
const DOCK_TITLE = /^herdr-pulse \d+$/;
const DOCK_LABEL = "Pulse";
const TIMEOUT_MS = 15 * 1000;
const REMOTES_EVERY_MS = 60 * 1000;
const REMOTE_CONCURRENCY = 8;
const OWNER = /^[A-Za-z0-9][A-Za-z0-9-]*$/;
const REPO = /^(?!\.{1,2}$)[A-Za-z0-9_][\w.-]*$/;
const WORKSPACE_ID = /^[\w:.-]{1,80}$/;

function run(command, args, env) {
  return new Promise((resolve, reject) => {
    execFile(command, args, { timeout: TIMEOUT_MS, env, maxBuffer: 16 * 1024 * 1024 }, (error, stdout) => (error ? reject(error) : resolve(stdout)));
  });
}

const defaultHerdr = (args) => run(HERDR, args);
const defaultGit = (cwd, args) => run("git", [...GIT_FLAGS, "-C", cwd, ...args], gitEnv(process.env));

export function parseRemote(url) {
  if (typeof url !== "string") return null;
  const match =
    /^git@github\.com:([\w.-]+)\/([\w.-]+?)(?:\.git)?\/?$/.exec(url) ||
    /^(?:https:\/\/|ssh:\/\/)(?:[^/@\s]+@)?github\.com\/([\w.-]+)\/([\w.-]+?)(?:\.git)?\/?$/.exec(url);
  if (!match || !OWNER.test(match[1]) || !REPO.test(match[2])) return null;
  return `${match[1]}/${match[2]}`;
}

function folderOf(pane) {
  const folder = pane.foreground_cwd || pane.cwd;
  return typeof folder === "string" && path.isAbsolute(folder) ? folder : null;
}

function workspaceOf(pane) {
  const id = pane.workspace_id ?? String(pane.pane_id ?? "").split(":")[0];
  return typeof id === "string" && WORKSPACE_ID.test(id) && !id.startsWith("-") ? id : null;
}

const isDock = (pane) => DOCK_TITLE.test(pane.terminal_title ?? "") || (pane.label === DOCK_LABEL && pane.cwd === process.cwd());
const lower = (value) => String(value ?? "").toLowerCase();

export function createWorkspaces({ herdr = defaultHerdr, git = defaultGit, now = Date.now } = {}) {
  let panes = [];
  let focused = null;
  let state = "loading";
  const remotes = new Map();
  let remotesAt = 0;
  let inflight = null;

  async function resolveRemotes(folders) {
    let next = 0;
    const worker = async () => {
      while (next < folders.length) {
        const folder = folders[next++];
        try {
          remotes.set(folder, parseRemote((await git(folder, ["remote", "get-url", "origin"])).trim()));
        } catch {
          remotes.set(folder, null);
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(REMOTE_CONCURRENCY, folders.length) }, worker));
  }

  const slugOf = (folder) => (folder ? remotes.get(folder) ?? null : null);

  function workspaceRepos() {
    const out = new Map();
    for (const pane of panes) {
      if (!out.has(pane.workspaceId)) out.set(pane.workspaceId, new Set());
      const slug = slugOf(pane.folder);
      if (slug) out.get(pane.workspaceId).add(lower(slug));
    }
    return out;
  }

  async function load() {
    let list;
    try {
      list = JSON.parse(await herdr(["pane", "list"]))?.result?.panes;
    } catch {
      list = null;
    }
    if (!Array.isArray(list)) {
      if (state === "loading") state = "unavailable";
      return false;
    }
    const self = list.find((pane) => pane.pane_id === process.env.HERDR_PANE_ID) ?? list.find((pane) => DOCK_TITLE.test(pane.terminal_title ?? ""));
    panes = list
      .filter((pane) => pane && pane !== self && !isDock(pane))
      .map((pane) => ({ workspaceId: workspaceOf(pane), tabId: pane.tab_id, folder: folderOf(pane), focused: pane.focused === true }))
      .filter((pane) => pane.workspaceId && pane.folder);
    if (self) {
      const siblings = panes.filter((pane) => pane.tabId === self.tab_id);
      const pick = siblings.find((pane) => pane.focused) ?? (focused ? null : siblings[0]);
      if (pick) focused = pick.folder;
    }
    const folders = [...new Set(panes.map((pane) => pane.folder))];
    const stale = now() - remotesAt >= REMOTES_EVERY_MS;
    if (stale) {
      remotesAt = now();
      for (const folder of remotes.keys()) if (!folders.includes(folder)) remotes.delete(folder);
    }
    await resolveRemotes(stale ? folders : folders.filter((folder) => !remotes.has(folder)));
    state = "ready";
    return true;
  }

  return {
    state: () => state,
    focusedFolder: () => focused,
    slugOf,
    workspaceRepos,
    openSlugs: () => new Set(panes.map((pane) => slugOf(pane.folder)).filter(Boolean).map(lower)),

    match(repo) {
      const target = lower(repo);
      const found = panes.filter((pane) => lower(slugOf(pane.folder)) === target && slugOf(pane.folder));
      const pick = found.find((pane) => pane.folder === focused) ?? found[0];
      return pick ? { workspaceId: pick.workspaceId, folder: pick.folder } : null;
    },

    refresh() {
      inflight ??= load().finally(() => (inflight = null));
      return inflight;
    },
  };
}

export function scopePulls(items, mode, workspaces) {
  const list = (Array.isArray(items) ? items : []).filter((item) => item.listed !== false);
  if (mode === "all") return { items: list, reason: null };
  if (workspaces.state() !== "ready") return { items: [], reason: workspaces.state() };
  const keep = (slugs) => list.filter((item) => slugs.has(lower(item.repo)));
  if (mode === "workspace") {
    const folder = workspaces.focusedFolder();
    if (!folder) return { items: [], reason: "no-workspace" };
    const slug = workspaces.slugOf(folder);
    if (!slug) return { items: [], reason: "no-remote" };
    return { items: keep(new Set([lower(slug)])), reason: null };
  }
  return { items: keep(workspaces.openSlugs()), reason: null };
}
