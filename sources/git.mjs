import { execFile } from "node:child_process";
import os from "node:os";
import path from "node:path";
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
const PR_TITLE_MAX = 72;
const SYSTEM_PROMPT = "You write git commit messages. Reply with one or two short sentences describing the change, in plain text. No quotes, no prefix, no markdown, no trailing explanation.";
const PR_SYSTEM_PROMPT = [
  "You write GitHub pull request titles and descriptions.",
  "Reply in exactly this shape: the title on the first line, one blank line, then the description.",
  `The title is plain text, under ${PR_TITLE_MAX} characters, in the imperative mood, with no prefix, quotes or trailing period.`,
  "The description is a brief summary of what changed and why: one short sentence, then two to five short markdown bullet points. No headings.",
  "Never mention AI, Claude, or how the text was written. No sign-off, no trailing explanation.",
].join(" ");
const GIT_ENV = { ...process.env, GIT_OPTIONAL_LOCKS: "0", GIT_TERMINAL_PROMPT: "0" };
const PRIVATE_PATHS = ["**/.env*", "**/*.pem", "**/*.key", "**/*.p12", "**/id_rsa*", "**/id_ed25519*", "**/*secret*", "**/*.lock", "**/*-lock.json", "**/*-lock.yaml"]
  .map((glob) => `:(exclude,glob)${glob}`);
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
const PR_ARGS = [...CLAUDE_FLAGS, "--system-prompt", PR_SYSTEM_PROMPT, "Write the pull request title and description for the branch on stdin."];
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

function exec(command, args, { cwd, input, env = GIT_ENV, timeout = 30 * 1000, detached = false } = {}) {
  return new Promise((resolve, reject) => {
    const child = execFile(command, args, { cwd, env, timeout, detached, maxBuffer: 64 * 1024 * 1024 }, (error, stdout, stderr) => {
      if (error) return reject(new Error(errorLine(stderr || error.message)));
      resolve(stdout);
    });
    child.stdin?.on("error", () => {});
    if (input != null) child.stdin.end(input);
  });
}

const git = (cwd, args, options) => exec("git", ["-c", "core.fsmonitor=false", "-C", cwd, ...args], options);

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
    files.push({ x, y, path: clean(entry.slice(3)) });
  }
  return files;
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
  let remote = { key: null, info: null, at: 0 };
  let remotePending = false;

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

  async function repoAt(cwd) {
    const top = (await git(cwd, ["rev-parse", "--show-toplevel"])).trim();
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
    };
  }

  const remoteKey = (r) => `${r.top}\0${r.current}\0${r.head}`;

  function fetchUpstream(force = false) {
    if (!repo?.upstream || fetching) return;
    if (!force && Date.now() - (fetchedAt.get(repo.top) ?? 0) < FETCH_EVERY_MS) return;
    fetching = true;
    fetchedAt.set(repo.top, Date.now());
    git(repo.top, ["fetch", "--quiet", "--no-tags"], { timeout: FETCH_TIMEOUT_MS, detached: true })
      .catch(() => {})
      .finally(() => {
        fetching = false;
        refresh();
      });
  }

  function queryRemote(r) {
    const [owner, name] = r.slug.split("/");
    const args = ["api", "graphql", "-f", `query=${REMOTE_QUERY}`, "-f", `owner=${owner}`, "-f", `name=${name}`, "-f", `ref=refs/heads/${r.current}`, "-f", `oid=${r.head}`];
    return exec("gh", args, { env: process.env }).then((stdout) => {
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
    if (refreshing) return;
    refreshing = true;
    try {
      const cwd = await findTarget().catch(() => target);
      repo = cwd ? await repoAt(cwd).catch(() => null) : null;
      files = repo
        ? parseStatus(await git(repo.top, ["status", "--porcelain=v1", "-z", "--untracked-files=all"]))
        : [];
    } catch {
      files = [];
    } finally {
      refreshing = false;
      const next = JSON.stringify([repo, files]);
      if (next !== signature) {
        signature = next;
        onChange();
      }
      fetchUpstream();
      updateRemote();
    }
  }

  async function describeChanges(target) {
    const staged = files.some(isStaged);
    const diff = await git(target.top, ["diff", "--no-ext-diff", "--no-textconv", "--no-color", ...(staged ? ["--cached"] : []), "--", ".", ...PRIVATE_PATHS]);
    const list = files
      .filter((file) => (staged ? isStaged(file) : true))
      .map((file) => `${kindOf(file)} ${file.path}`)
      .join("\n");
    return `Files:\n${list}\n\nDiff:\n${diff.slice(0, MAX_DIFF_CHARS)}`;
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
    const stat = await git(target.top, ["diff", "--no-ext-diff", "--no-textconv", "--no-color", "--stat", `${baseRef}...HEAD`, "--", ".", ...PRIVATE_PATHS]);
    const diff = await git(target.top, ["diff", "--no-ext-diff", "--no-textconv", "--no-color", `${baseRef}...HEAD`, "--", ".", ...PRIVATE_PATHS]);
    if (!log.trim()) throw new Error(`no commits ahead of ${base}`);
    return `Branch: ${target.current}\nBase: ${base}\n\nCommits:\n${log.trim()}\n\nFiles:\n${stat.trim()}\n\nDiff:\n${diff.slice(0, MAX_DIFF_CHARS)}`;
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
    refresh,

    sync: refresh,

    stageAll: (target) => git(target.top, ["add", "-A"]),

    async generateMessage(target) {
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
      await git(target.top, ["fetch", "--quiet", "--no-tags"], { timeout: FETCH_TIMEOUT_MS, detached: true });
      fetchedAt.set(target.top, Date.now());
      await git(target.top, ["merge", "--ff-only", "@{upstream}"], { timeout: COMMIT_TIMEOUT_MS });
    },

    async createPullRequest(target, base) {
      const input = await describeBranch(target, base);
      const { title, body } = parsePullRequest(await claude(PR_ARGS, input), target.current);
      const args = ["pr", "create", "--repo", target.slug, "--head", target.current, "--base", base, "--title", title, "--body", body];
      const output = await exec("gh", args, { cwd: target.top, env: process.env, timeout: PUSH_TIMEOUT_MS, detached: true });
      const url = output.trim().split("\n").find((line) => /^https:\/\/github\.com\/.+\/pull\/\d+/.test(line.trim()))?.trim();
      remote.at = 0;
      return { url, number: Number(url?.match(/\/pull\/(\d+)/)?.[1]) || null };
    },
  };
}
