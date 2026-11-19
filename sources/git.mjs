import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { configNames, fetchOffHint, ghEnv, GIT_FLAGS, gitEnv, isPrivatePath, statusAllowed, unsafeFetchKey } from "../lib/git-safety.mjs";
import { setting } from "../lib/settings.mjs";
import { clean } from "../lib/term.mjs";

const HERDR = process.env.HERDR_BIN_PATH || "herdr";
const MAX_DIFF_CHARS = 24000;
const MAX_LOG_COMMITS = 50;
const CLAUDE_TIMEOUT_MS = 90 * 1000;
const COMMIT_TIMEOUT_MS = 2 * 60 * 1000;
const PUSH_TIMEOUT_MS = 2 * 60 * 1000;
const FETCH_TIMEOUT_MS = 60 * 1000;
const FETCH_EVERY_MS = 2 * 60 * 1000;
const REMOTE_EVERY_MS = 60 * 1000;
const CONFIG_EVERY_MS = 60 * 1000;
const MAX_DIFF_PATHS = 300;
const LITERAL_PATHSPECS = { GIT_LITERAL_PATHSPECS: "1" };
const STATUS_ARGS = ["status", "--porcelain=v1", "-z", "--untracked-files=all"];
const DIFF_ARGS = ["diff", "--no-ext-diff", "--no-textconv", "--no-color", "--no-renames"];
const PR_TITLE_MAX = 72;
const PR_TEMPLATE_MAX_CHARS = 8000;
const PR_TEMPLATE_DIRS = [".github/", "", "docs/"];
const PR_TEMPLATE_NAME = /^pull_request_template\.(md|txt)$/i;
const DISCOVER_EVERY_MS = 30 * 1000;
const SUMMARY_EVERY_MS = 6 * 1000;
const HOLD_MS = 5 * 1000;
const MAX_REPOS = 12;
const MAX_CANDIDATES = 48;
const MAX_DEPTH = 3;
const MAX_DIRS = 400;
const MAX_STATS = 300;
const SKIP_DIRS = new Set(["node_modules", "vendor", "Pods", "DerivedData", "build", "dist"]);
const SYSTEM_PROMPT = "You write git commit messages. Reply with one or two short sentences describing the change, in plain text. No quotes, no prefix, no markdown, no trailing explanation.";
const PR_DESCRIPTION = "The description is a brief summary of what changed and why: one short sentence, then two to five short markdown bullet points. No headings.";
const PR_TEMPLATE_DESCRIPTION = [
  "The description fills in the pull request template given on stdin: keep its headings, sections and checklists in the same order,",
  "replace placeholder text and HTML comments with content from the branch, tick only checklist items the commits or diff clearly support,",
  "and write N/A under a section that does not apply.",
].join(" ");
const CLAUDE_FLAGS = [
  "-p",
  "--model", "haiku",
  "--no-session-persistence",
  "--setting-sources", "",
  "--strict-mcp-config",
  "--tools", "",
  "--disable-slash-commands",
];
const COMMIT_ARGS = [...CLAUDE_FLAGS, "--system-prompt", SYSTEM_PROMPT, "Write the commit message for the changes on stdin."];

function prArgs(templated) {
  const systemPrompt = [
    "You write GitHub pull request titles and descriptions.",
    "Reply in exactly this shape: the title on the first line, one blank line, then the description.",
    `The title is plain text, under ${PR_TITLE_MAX} characters, in the imperative mood, with no prefix, quotes or trailing period.`,
    templated ? PR_TEMPLATE_DESCRIPTION : PR_DESCRIPTION,
    "Never mention AI, Claude, or how the text was written. No sign-off, no trailing explanation.",
  ].join(" ");
  return [...CLAUDE_FLAGS, "--system-prompt", systemPrompt, "Write the pull request title and description for the branch on stdin."];
}
const REMOTE_QUERY = `query($owner: String!, $name: String!, $ref: String!, $oid: GitObjectID!) {
  repository(owner: $owner, name: $name) {
    defaultBranchRef { name }
    ref(qualifiedName: $ref) { associatedPullRequests(states: OPEN, first: 1) { nodes { number url isDraft } } }
    object(oid: $oid) { ... on Commit { statusCheckRollup { state } } }
  }
}`;

function errorLine(stderr) {
  if (stderr.includes("[rejected]")) return "rejected, the remote has new commits: pull first";
  if (stderr.includes("Not possible to fast-forward")) return "branches have diverged: pull from a terminal";
  if (stderr.includes("would be overwritten by merge")) return "local changes would be overwritten: commit or stash first";
  const lines = stderr.trim().split("\n");
  const reason = lines.find((line) => /^(fatal|error): /.test(line)) ?? lines.at(-1);
  return clean(reason.replace(/^(fatal|error): /, ""));
}

function exec(command, args, { cwd, input, env = process.env, timeout = 30 * 1000, detached = false } = {}) {
  return new Promise((resolve, reject) => {
    const child = execFile(command, args, { cwd, env, timeout, detached, maxBuffer: 64 * 1024 * 1024 }, (error, stdout, stderr) => {
      if (error) return reject(new Error(errorLine(stderr || error.message)));
      resolve(stdout);
    });
    child.stdin?.on("error", () => {});
    if (input != null) child.stdin.end(input);
  });
}

const git = (cwd, args, options = {}) => exec("git", [...GIT_FLAGS, "-C", cwd, ...args], { ...options, env: { ...gitEnv(process.env), ...options.env } });
const publicPaths = (paths) => [...new Set(paths)].filter((name) => name && !isPrivatePath(name)).slice(0, MAX_DIFF_PATHS);

function githubRemote(remotes) {
  const found = remotes
    .split("\n")
    .map((line) => line.match(/^(\S+)\s+\S*github\.com[:/]([^/\s]+)\/(\S+?)(?:\.git)?\/?\s/))
    .filter(Boolean)
    .map(([, name, owner, repo]) => ({ name, slug: `${owner}/${repo}` }));
  return found.find((remote) => remote.name === "origin") ?? found[0] ?? null;
}

function parseStatus(raw) {
  const parts = raw.split("\0");
  const files = [];
  for (let i = 0; i < parts.length; i++) {
    const entry = parts[i];
    if (entry.length < 4) continue;
    const [x, y] = entry;
    if (x === "R" || x === "C") i++;
    files.push({ x, y, path: clean(entry.slice(3)), raw: entry.slice(3) });
  }
  return files;
}

function parseSummary(raw) {
  const summary = { oid: "", branch: "", upstream: false, ahead: 0, behind: 0, paths: [] };
  const parts = raw.split("\0");
  for (let i = 0; i < parts.length; i++) {
    const entry = parts[i];
    const fields = entry.split(" ");
    if (entry.startsWith("# branch.oid ")) summary.oid = fields[2];
    else if (entry.startsWith("# branch.head ")) summary.branch = fields.slice(2).join(" ");
    else if (entry.startsWith("# branch.upstream ")) summary.upstream = true;
    else if (entry.startsWith("# branch.ab ")) [summary.ahead, summary.behind] = fields.slice(2, 4).map((n) => Math.abs(Number(n)) || 0);
    else if (entry.startsWith("1 ")) summary.paths.push(fields.slice(8).join(" "));
    else if (entry.startsWith("2 ")) {
      summary.paths.push(fields.slice(9).join(" "));
      i++;
    } else if (entry.startsWith("u ")) summary.paths.push(fields.slice(10).join(" "));
    else if (entry.startsWith("? ")) summary.paths.push(entry.slice(2));
  }
  return summary;
}

function claude(args, input) {
  return exec("claude", args, { cwd: os.tmpdir(), input, env: process.env, timeout: CLAUDE_TIMEOUT_MS });
}

export function kindOf({ x, y }) {
  if (x === "?") return "new";
  if (x === "U" || y === "U" || (x === "A" && y === "A") || (x === "D" && y === "D")) return "conflict";
  const code = x !== " " ? x : y;
  return { A: "added", D: "deleted", R: "renamed", C: "copied" }[code] ?? "modified";
}

export const isStaged = ({ x }) => x !== " " && x !== "?";
export const isUnstaged = ({ y }) => y !== " ";

export function createGitSource({ selfMarker, onChange }) {
  let target = null;
  let repo = null;
  let files = [];
  let signature = "";
  let refreshing = false;
  let fetching = false;
  const fetchedAt = new Map();
  const fetchHints = new Map();
  const configs = new Map();
  const configChecks = new Map();
  let remote = { key: null, info: null, at: 0 };
  let remotePending = false;
  let workspace = null;
  let heldUntil = 0;
  let again = false;

  async function findTarget() {
    const panes = JSON.parse(await exec(HERDR, ["pane", "list"])).result.panes;
    const self = panes.find((pane) => pane.pane_id === process.env.HERDR_PANE_ID)
      ?? panes.find((pane) => pane.terminal_title === selfMarker);
    if (!self) return target;
    const siblings = panes.filter((pane) => pane.tab_id === self.tab_id && pane.pane_id !== self.pane_id);
    const pick = siblings.find((pane) => pane.focused) ?? (target ? null : siblings[0]);
    if (pick) target = pick.foreground_cwd || pick.cwd;
    return target;
  }

  const topLevel = async (cwd) => (await git(cwd, ["rev-parse", "--show-toplevel"])).trim();

  async function gitDirs(cwd) {
    const lines = (await git(cwd, ["rev-parse", "--git-common-dir", "--git-dir"]).catch(() => "")).split("\n").map((line) => line.trim());
    if (!lines[0] || !lines[1]) return null;
    return { config: path.resolve(cwd, lines[0], "config"), worktree: path.resolve(cwd, lines[1], "config.worktree") };
  }

  async function configStamp(dirs) {
    if (!dirs) return "";
    const parts = await Promise.all(
      [dirs.config, dirs.worktree].map((file) => fs.stat(file).then((info) => `${info.ino}:${info.size}:${info.mtimeMs}`, () => "-")),
    );
    return parts.join("|");
  }

  async function readConfigKeys(cwd, dirs) {
    const keys = configNames(await git(cwd, ["config", "--local", "--name-only", "-z", "--list"]));
    if (!keys.includes("extensions.worktreeconfig")) return keys;
    if (!dirs) return null;
    const exists = await fs.lstat(dirs.worktree).then(() => true, (error) => (error?.code === "ENOENT" ? false : null));
    if (exists === false) return keys;
    if (exists === null) return null;
    return [...keys, ...configNames(await git(cwd, ["config", "--worktree", "--name-only", "-z", "--list"]))];
  }

  async function configKeys(cwd) {
    const cached = configs.get(cwd);
    if (cached && Date.now() - cached.at < CONFIG_EVERY_MS && (await configStamp(cached.dirs)) === cached.stamp) return cached.keys;
    if (configChecks.has(cwd)) return configChecks.get(cwd);
    const check = (async () => {
      const dirs = await gitDirs(cwd);
      const stamp = await configStamp(dirs);
      const keys = await readConfigKeys(cwd, dirs).catch(() => null);
      configs.set(cwd, { keys, dirs, stamp, at: Date.now() });
      return keys;
    })().finally(() => configChecks.delete(cwd));
    configChecks.set(cwd, check);
    return check;
  }

  const statusPaused = async (top) => !statusAllowed(await configKeys(top));

  async function discover(root) {
    const candidates = [];
    let level = [root];
    let visited = 0;
    for (let depth = 1; depth <= MAX_DEPTH && level.length && visited < MAX_DIRS; depth++) {
      const next = [];
      for (const dir of level) {
        if (visited++ >= MAX_DIRS) break;
        for (const entry of await fs.readdir(dir, { withFileTypes: true }).catch(() => [])) {
          if (!entry.isDirectory() || entry.name.startsWith(".") || SKIP_DIRS.has(entry.name)) continue;
          const child = path.join(dir, entry.name);
          (existsSync(path.join(child, ".git")) ? candidates : next).push(child);
        }
      }
      level = next;
    }
    const sorted = candidates.sort((a, b) => a.localeCompare(b)).slice(0, MAX_CANDIDATES);
    const found = await Promise.all(sorted.map(async (dir) => {
      const top = await topLevel(dir).catch(() => null);
      if (!top || !githubRemote(await git(top, ["remote", "-v"]).catch(() => ""))) return null;
      return { top, name: clean(path.relative(root, dir)) };
    }));
    return found.filter(Boolean).slice(0, MAX_REPOS);
  }

  async function summarize(child) {
    if (await statusPaused(child.top)) {
      const branch = (await git(child.top, ["symbolic-ref", "--quiet", "--short", "HEAD"]).catch(() => "")).trim();
      return { ...child, branch: clean(branch), upstream: false, ahead: 0, behind: 0, changed: 0, activity: 0, paused: true };
    }
    const raw = await git(child.top, ["status", "--porcelain=v2", "--branch", "-z", "--untracked-files=all"]);
    const { oid, branch, paths, ...counts } = parseSummary(raw);
    const times = await Promise.all(paths.slice(0, MAX_STATS).map((file) => fs.stat(path.join(child.top, file)).then((stat) => stat.mtimeMs, () => 0)));
    const name = branch === "(detached)" ? oid.slice(0, 7) : branch;
    return { ...child, ...counts, branch: clean(name), changed: paths.length, activity: Math.max(0, ...times), paused: false };
  }

  function choose() {
    if (workspace.shown && !workspace.repos.some((r) => r.top === workspace.shown)) workspace.shown = null;
    if (Date.now() < heldUntil) return;
    const newest = workspace.repos.filter((r) => r.changed).reduce((best, r) => (!best || r.activity > best.activity ? r : best), null);
    if (newest && newest.top !== workspace.shown && newest.activity > workspace.chosenAt) {
      workspace.shown = newest.top;
      workspace.chosenAt = newest.activity;
    }
  }

  async function refreshWorkspace(root) {
    if (workspace?.root !== root) workspace = { root, children: [], repos: [], scannedAt: 0, summarizedAt: 0, shown: null, chosenAt: 0 };
    const now = Date.now();
    if (now - workspace.scannedAt >= DISCOVER_EVERY_MS) {
      workspace.children = await discover(root).catch(() => []);
      workspace.scannedAt = now;
      workspace.summarizedAt = 0;
    }
    if (now - workspace.summarizedAt >= SUMMARY_EVERY_MS) {
      const empty = { branch: "", upstream: false, ahead: 0, behind: 0, changed: 0, activity: 0, paused: false };
      workspace.repos = await Promise.all(workspace.children.map((child) => summarize(child).catch(() => ({ ...child, ...empty }))));
      workspace.summarizedAt = now;
    }
    choose();
  }

  function pick(top) {
    if (!workspace) return;
    workspace.shown = top;
    workspace.chosenAt = Date.now();
    refresh();
  }

  async function repoAt(top) {
    const github = githubRemote(await git(top, ["remote", "-v"]));
    if (!github) return null;
    const current = (await git(top, ["branch", "--show-current"])).trim();
    const head = (await git(top, ["rev-parse", "HEAD"]).catch(() => "")).trim();
    const branch = current || (head ? head.slice(0, 7) : "detached");
    const counts = current ? await git(top, ["rev-list", "--left-right", "--count", "HEAD...@{upstream}"]).catch(() => null) : null;
    const [ahead, behind] = counts ? counts.trim().split(/\s+/).map((n) => Number(n) || 0) : [0, 0];
    return {
      top,
      name: clean(path.basename(top)),
      branch: clean(branch),
      current,
      head,
      remote: github.name,
      slug: github.slug,
      upstream: counts !== null,
      ahead,
      behind,
      paused: await statusPaused(top),
    };
  }

  const remoteKey = (r) => `${r.top}\0${r.current}\0${r.head}`;

  async function safeFetch(top) {
    const unsafe = unsafeFetchKey(await configKeys(top));
    if (unsafe !== null) return fetchHints.set(top, fetchOffHint(unsafe));
    fetchHints.delete(top);
    await git(top, ["fetch", "--quiet", "--no-tags", "--no-recurse-submodules"], { timeout: FETCH_TIMEOUT_MS, detached: true });
  }

  function fetchUpstream(force = false) {
    if (!repo?.upstream || fetching) return;
    if (!force && Date.now() - (fetchedAt.get(repo.top) ?? 0) < FETCH_EVERY_MS) return;
    fetching = true;
    fetchedAt.set(repo.top, Date.now());
    safeFetch(repo.top)
      .catch(() => {})
      .finally(() => {
        fetching = false;
        refresh();
      });
  }

  function queryRemote(r) {
    const [owner, name] = r.slug.split("/");
    const args = ["api", "graphql", "-f", `query=${REMOTE_QUERY}`, "-f", `owner=${owner}`, "-f", `name=${name}`, "-f", `ref=refs/heads/${r.current}`, "-f", `oid=${r.head}`];
    return exec("gh", args, { env: ghEnv(process.env) }).then((stdout) => {
      const data = JSON.parse(stdout).data?.repository;
      if (!data) throw new Error("unexpected response from gh");
      const pr = data.ref?.associatedPullRequests.nodes[0] ?? null;
      return {
        defaultBranch: data.defaultBranchRef?.name ?? null,
        pr: pr ? { number: pr.number, url: pr.url, draft: pr.isDraft } : null,
        checks: data.object?.statusCheckRollup?.state ?? null,
      };
    });
  }

  function updateRemote(force = false) {
    if (!repo?.current || !repo.head || remotePending) return;
    const key = remoteKey(repo);
    if (!force && key === remote.key && Date.now() - remote.at < REMOTE_EVERY_MS) return;
    remotePending = true;
    queryRemote(repo)
      .then((info) => (remote = { key, info, at: Date.now() }))
      .catch(() => (remote = { key, info: remote.key === key ? remote.info : null, at: Date.now() }))
      .finally(() => {
        remotePending = false;
        onChange();
      });
  }

  async function refresh() {
    if (refreshing) {
      again = true;
      return;
    }
    refreshing = true;
    try {
      const cwd = await findTarget().catch(() => target);
      const top = cwd ? await topLevel(cwd).catch(() => null) : null;
      if (top || !cwd) workspace = null;
      else await refreshWorkspace(cwd);
      const shown = top ?? workspace?.shown;
      repo = shown ? await repoAt(shown).catch(() => null) : null;
      files = repo && !repo.paused ? parseStatus(await git(repo.top, STATUS_ARGS)) : [];
    } catch {
      files = [];
    } finally {
      refreshing = false;
      const next = JSON.stringify([repo, files, workspace && [workspace.shown, workspace.repos], repo && fetchHints.get(repo.top)]);
      if (next !== signature) {
        signature = next;
        onChange();
      }
      fetchUpstream();
      updateRemote();
      if (again) {
        again = false;
        refresh();
      }
    }
  }

  async function describeChanges(target) {
    const current = target.paused ? parseStatus(await git(target.top, STATUS_ARGS)) : files;
    if (!current.length) throw new Error("no changes");
    const staged = current.some(isStaged);
    const used = current.filter((file) => (staged ? isStaged(file) : true)).filter((file) => !isPrivatePath(file.raw));
    const paths = publicPaths(used.map((file) => file.raw));
    const diff = paths.length ? await git(target.top, [...DIFF_ARGS, ...(staged ? ["--cached"] : []), "--", ...paths], { env: LITERAL_PATHSPECS }) : "";
    const list = used.slice(0, 100).map((file) => `${kindOf(file)} ${file.path}`).join("\n");
    return `Files:\n${list}\n\nDiff:\n${diff.slice(0, MAX_DIFF_CHARS)}`;
  }

  async function findTemplate(top, ref) {
    const names = async (...args) => (await git(top, ["ls-tree", "--name-only", ...args]).catch(() => "")).split("\n").filter(Boolean);
    const files = [...(await names(ref)), ...(await names("-r", ref, "--", ".github", "docs", "PULL_REQUEST_TEMPLATE", "pull_request_template"))];
    const inside = (file, dir) => file.toLowerCase().startsWith(dir) && !file.slice(dir.length).includes("/");
    for (const dir of PR_TEMPLATE_DIRS) {
      const folder = `${dir}pull_request_template/`;
      const choices = files.filter((file) => inside(file, folder) && /\.(md|txt)$/i.test(file)).sort();
      const file = files.find((f) => inside(f, dir) && PR_TEMPLATE_NAME.test(f.slice(dir.length)))
        ?? choices.find((f) => /^default\.(md|txt)$/i.test(path.basename(f)))
        ?? choices[0];
      if (!file) continue;
      const text = (await git(top, ["cat-file", "blob", `${ref}:${file}`]).catch(() => "")).trim();
      if (text) return text.slice(0, PR_TEMPLATE_MAX_CHARS);
    }
    return null;
  }

  async function describeBranch(target, base) {
    const upstreamRemote = (await git(target.top, ["config", "--get", `branch.${target.current}.remote`]).catch(() => "")).trim();
    const candidates = [...new Set([upstreamRemote, target.remote].filter(Boolean))].map((name) => `${name}/${base}`);
    let baseRef = null;
    for (const ref of candidates) {
      if (await git(target.top, ["rev-parse", "--verify", "--quiet", `refs/remotes/${ref}`]).then(() => true, () => false)) {
        baseRef = ref;
        break;
      }
    }
    if (!baseRef) throw new Error(`can't find ${base} on the remote: fetch it first`);
    const log = await git(target.top, ["log", "--no-color", "--format=- %s%n%b", `--max-count=${MAX_LOG_COMMITS}`, `${baseRef}..HEAD`]);
    const range = `${baseRef}...HEAD`;
    const names = await git(target.top, ["diff", "--name-only", "-z", "--no-ext-diff", "--no-textconv", "--no-renames", range, "--"], { env: LITERAL_PATHSPECS });
    const paths = publicPaths(names.split("\0"));
    const [stat, diff] = paths.length
      ? await Promise.all([
        git(target.top, [...DIFF_ARGS, "--stat", range, "--", ...paths], { env: LITERAL_PATHSPECS }),
        git(target.top, [...DIFF_ARGS, range, "--", ...paths], { env: LITERAL_PATHSPECS }),
      ])
      : ["", ""];
    if (!log.trim()) throw new Error(`no commits ahead of ${base}`);
    const template = await findTemplate(target.top, `refs/remotes/${baseRef}`);
    const templateText = template ? `Template:\n${template}\n\n` : "";
    const input = `Branch: ${target.current}\nBase: ${base}\n\nCommits:\n${log.trim()}\n\nFiles:\n${stat.trim()}\n\n${templateText}Diff:\n${diff.slice(0, MAX_DIFF_CHARS)}`;
    return { input, templated: Boolean(template) };
  }

  function parsePullRequest(output, branch) {
    const lines = output.replace(/\r/g, "").split("\n").map((line) => clean(line));
    const at = lines.findIndex((line) => line.trim());
    const title = (lines[at] ?? "").trim().replace(/^#+\s*/, "").replace(/^["'`]+|["'`]+$/g, "").slice(0, PR_TITLE_MAX * 2);
    const body = lines.slice(at + 1).join("\n").trim();
    const unprefixed = title.startsWith(`${branch}:`) ? title.slice(branch.length + 1).trim() : title;
    if (!unprefixed) throw new Error("empty pull request title");
    return { title: unprefixed.charAt(0).toUpperCase() + unprefixed.slice(1), body };
  }

  return {
    repo: () => repo,
    files: () => files,
    remote: () => (repo && remote.key === remoteKey(repo) ? remote.info : null),
    fetchHint: () => (repo ? fetchHints.get(repo.top) ?? null : null),
    workspace: () => (workspace?.repos.length ? { name: clean(path.basename(workspace.root)), repos: workspace.repos } : null),
    refresh,

    select: pick,
    showAll: () => pick(null),
    hold: () => (heldUntil = Date.now() + HOLD_MS),

    sync: refresh,

    stageAll: (target) => git(target.top, ["add", "-A"]),

    async generateMessage(target) {
      if (!setting("git.aiMessages")) throw new Error("AI messages are disabled");
      const input = await describeChanges(target);
      const output = await claude(COMMIT_ARGS, input);
      const sentence = clean(output).trim().replace(/\s+/g, " ").replace(/^["'`]+|["'`]+$/g, "");
      if (!sentence) throw new Error("empty message");
      return `${target.branch}: ${sentence}`;
    },

    async commit(target, message) {
      await git(target.top, ["commit", "-m", message], { timeout: COMMIT_TIMEOUT_MS });
      return (await git(target.top, ["rev-parse", "--short", "HEAD"])).trim();
    },

    async push(target) {
      const args = target.upstream ? ["push"] : ["push", "--set-upstream", target.remote, target.current];
      await git(target.top, args, { timeout: PUSH_TIMEOUT_MS, detached: true });
      fetchedAt.set(target.top, Date.now());
      remote.at = 0;
    },

    async pull(target) {
      await git(target.top, ["fetch", "--quiet", "--no-tags", "--no-recurse-submodules"], { timeout: FETCH_TIMEOUT_MS, detached: true });
      fetchedAt.set(target.top, Date.now());
      await git(target.top, ["merge", "--ff-only", "@{upstream}"], { timeout: COMMIT_TIMEOUT_MS });
    },

    async createPullRequest(target, base) {
      let args = ["pr", "create", "--fill", "--repo", target.slug, "--head", target.current, "--base", base];
      if (setting("git.aiMessages")) {
        const { input, templated } = await describeBranch(target, base);
        const { title, body } = parsePullRequest(await claude(prArgs(templated), input), target.current);
        args = ["pr", "create", "--repo", target.slug, "--head", target.current, "--base", base, "--title", title, "--body", body];
      }
      const output = await exec("gh", args, { cwd: target.top, env: ghEnv(process.env), timeout: PUSH_TIMEOUT_MS, detached: true });
      const url = output.trim().split("\n").find((line) => /^https:\/\/github\.com\/.+\/pull\/\d+/.test(line.trim()))?.trim();
      remote.at = 0;
      return { url, number: Number(url?.match(/\/pull\/(\d+)/)?.[1]) || null };
    },
  };
}
