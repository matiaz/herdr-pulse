import { execFile } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { clean } from "../lib/term.mjs";

const HERDR = process.env.HERDR_BIN_PATH || "herdr";
const MAX_DIFF_CHARS = 24000;
const CLAUDE_TIMEOUT_MS = 90 * 1000;
const COMMIT_TIMEOUT_MS = 2 * 60 * 1000;
const PUSH_TIMEOUT_MS = 2 * 60 * 1000;
const SYSTEM_PROMPT = "You write git commit messages. Reply with one or two short sentences describing the change, in plain text. No quotes, no prefix, no markdown, no trailing explanation.";
const GIT_ENV = { ...process.env, GIT_OPTIONAL_LOCKS: "0", GIT_TERMINAL_PROMPT: "0" };
const PRIVATE_PATHS = ["**/.env*", "**/*.pem", "**/*.key", "**/*.p12", "**/id_rsa*", "**/id_ed25519*", "**/*secret*", "**/*.lock", "**/*-lock.json", "**/*-lock.yaml"]
  .map((glob) => `:(exclude,glob)${glob}`);
const CLAUDE_ARGS = [
  "-p",
  "--model", "haiku",
  "--no-session-persistence",
  "--setting-sources", "",
  "--strict-mcp-config",
  "--tools", "",
  "--disable-slash-commands",
  "--system-prompt", SYSTEM_PROMPT,
  "Write the commit message for the changes on stdin.",
];

function errorLine(stderr) {
  if (stderr.includes("[rejected]")) return "rejected, the remote has new commits: pull first";
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
  const names = remotes.split("\n").filter((line) => /github\.com[:/]/.test(line)).map((line) => line.split("\t")[0]);
  return names.includes("origin") ? "origin" : names[0] ?? null;
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
    const remote = githubRemote(await git(top, ["remote", "-v"]));
    if (!remote) return null;
    const current = (await git(top, ["branch", "--show-current"])).trim();
    const branch = current || (await git(top, ["rev-parse", "--short", "HEAD"]).catch(() => "detached")).trim();
    const ahead = current ? await git(top, ["rev-list", "--count", "@{upstream}..HEAD"]).catch(() => null) : null;
    return {
      top,
      name: clean(path.basename(top)),
      branch: clean(branch),
      current,
      remote,
      upstream: ahead !== null,
      ahead: ahead === null ? 0 : Number(ahead.trim()) || 0,
    };
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

  return {
    repo: () => repo,
    files: () => files,
    refresh,

    stageAll: (target) => git(target.top, ["add", "-A"]),

    async generateMessage(target) {
      const input = await describeChanges(target);
      const output = await exec("claude", CLAUDE_ARGS, { cwd: os.tmpdir(), input, env: process.env, timeout: CLAUDE_TIMEOUT_MS });
      const sentence = clean(output).trim().replace(/\s+/g, " ").replace(/^["'`]+|["'`]+$/g, "");
      if (!sentence) throw new Error("empty message");
      return `${target.branch}: ${sentence}`;
    },

    async commit(target, message) {
      await git(target.top, ["commit", "-m", message], { timeout: COMMIT_TIMEOUT_MS });
      return (await git(target.top, ["rev-parse", "--short", "HEAD"])).trim();
    },

    push(target) {
      const args = target.upstream ? ["push"] : ["push", "--set-upstream", target.remote, target.current];
      return git(target.top, args, { timeout: PUSH_TIMEOUT_MS, detached: true });
    },
  };
}
