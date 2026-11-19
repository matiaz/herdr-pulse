import { clean } from "./term.mjs";

const GIT_CONFIG = [
  ["core.fsmonitor", "false"],
  ["core.hooksPath", "/dev/null"],
  ["diff.external", ""],
  ["core.pager", "cat"],
  ["core.alternateRefsCommand", ""],
];

export const GIT_FLAGS = GIT_CONFIG.flatMap(([key, value]) => ["-c", `${key}=${value}`]);

export function gitConfigEnv() {
  const env = { GIT_CONFIG_COUNT: String(GIT_CONFIG.length) };
  GIT_CONFIG.forEach(([key, value], index) => {
    env[`GIT_CONFIG_KEY_${index}`] = key;
    env[`GIT_CONFIG_VALUE_${index}`] = value;
  });
  return env;
}

export function gitEnv(base) {
  const env = {};
  for (const [key, value] of Object.entries(base)) {
    if (key.startsWith("GIT_") || key === "SSH_ASKPASS" || key === "SSH_ASKPASS_REQUIRE") continue;
    env[key] = value;
  }
  return { ...env, GIT_TERMINAL_PROMPT: "0", GIT_OPTIONAL_LOCKS: "0", GIT_PAGER: "cat", LC_ALL: "C" };
}

export function ghEnv(base) {
  return { ...base, GH_PROMPT_DISABLED: "1", NO_COLOR: "1", ...gitConfigEnv() };
}

export const STATUS_OFF_HINT = "Automatic status is paused because this repo's local git config can run filter commands. Stage, commit, pull and push still work.";

export const fetchOffHint = (key) => `Background fetch is off for this repo: its local git config sets ${clean(key).slice(0, 80)}, which Pulse does not treat as safe. Pull and push still work.`;

const STATUS_UNSAFE_KEY = /^(filter|include|includeif)\./;
const FETCH_SAFE_KEYS = new Set([
  "core.repositoryformatversion",
  "core.filemode",
  "core.bare",
  "core.logallrefupdates",
  "core.ignorecase",
  "core.precomposeunicode",
  "core.symlinks",
  "submodule.active",
  "extensions.objectformat",
  "extensions.refstorage",
  "user.name",
  "user.email",
  "commit.gpgsign",
  "pull.rebase",
  "pull.ff",
  "push.default",
  "init.defaultbranch",
  "gc.auto",
  "lfs.repositoryformatversion",
]);
const FETCH_SAFE_PATTERNS = [/^remote\..+\.(url|fetch|prune|tagopt)$/, /^branch\..+\.(remote|merge|rebase)$/, /^submodule\..+\.(url|active)$/];

export function statusAllowed(keys) {
  return Array.isArray(keys) && !keys.some((key) => STATUS_UNSAFE_KEY.test(String(key).toLowerCase()));
}

export function unsafeFetchKey(keys) {
  if (!Array.isArray(keys)) return "unreadable config";
  for (const item of keys) {
    const key = String(item).toLowerCase();
    if (!FETCH_SAFE_KEYS.has(key) && !FETCH_SAFE_PATTERNS.some((pattern) => pattern.test(key))) return key;
  }
  return null;
}

export function configNames(stdout) {
  return String(stdout ?? "").split("\0").filter(Boolean).map((key) => key.toLowerCase());
}

const EXACT_NAMES = new Set(["npm-shrinkwrap.json", "go.sum", "bun.lockb", ".npmrc", ".netrc", ".pypirc", "kubeconfig", ".htpasswd", ".dockercfg"]);
const NAME_PATTERNS = [
  /^\.env/,
  /\.(pem|key|p12|pfx|p8|ppk|gpg|asc|ovpn|jks|keystore|kdbx|tfvars)$/,
  /\.tfstate(\.backup)?$/,
  /^id_(rsa|dsa|ed25519|ecdsa)/,
  /service-account.*\.json$/,
  /\.lock$/,
  /-lock\.[a-z]+$/,
];

export function isPrivatePath(filePath) {
  if (typeof filePath !== "string" || !filePath) return false;
  const segments = filePath.toLowerCase().split(/[\\/]/).filter(Boolean);
  if (!segments.length) return false;
  if (segments.some((segment) => segment.includes("secret") || segment.includes("credential"))) return true;
  const name = segments[segments.length - 1];
  return EXACT_NAMES.has(name) || NAME_PATTERNS.some((pattern) => pattern.test(name));
}
