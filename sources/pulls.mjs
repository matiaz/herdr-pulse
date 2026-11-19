import { execFile } from "node:child_process";
import { ghEnv } from "../lib/git-safety.mjs";
import { readJson, writeJson } from "../lib/store.mjs";
import { clean } from "../lib/term.mjs";

const CACHE_FILE = "pulls.json";
const REFETCH_AFTER_MS = 2 * 60 * 1000;
const GH_TIMEOUT_MS = 60 * 1000;
const SEARCHES = {
  authored: "is:pr is:open archived:false author:@me",
  assigned: "is:pr is:open archived:false assignee:@me",
  review: "is:pr is:open archived:false review-requested:@me",
  reviewed: "is:pr is:open archived:false reviewed-by:@me",
};
const UNLISTED = new Set(["reviewed"]);
const QUERY = `query {
  viewer { login }
  ${Object.entries(SEARCHES).map(([alias, q]) => `${alias}: search(query: "${q}", type: ISSUE, first: 50) { nodes { ...pr } }`).join("\n  ")}
}
fragment pr on PullRequest {
  number title url isDraft updatedAt reviewDecision mergeable mergeStateStatus headRefOid
  viewerLatestReview { state commit { oid } }
  author { login }
  repository { nameWithOwner }
  commits(last: 1) { nodes { commit { statusCheckRollup { state } } } }
}`;

export const ACTIONS = ["merge", "failing", "conflict", "changes", "behind", "review", "running", "waiting", "draft"];
export const PULL_URL = /^https:\/\/github\.com\/([\w.-]+)\/([\w.-]+)\/pull\/(\d+)$/;
const NOTABLE = new Set(["merge", "failing"]);
const OID = /^[0-9a-f]{40}$/;
const WORD = /^[A-Z_]{1,40}$/;

export const isPullUrl = (url) => typeof url === "string" && PULL_URL.test(url);

export function cap(text, max) {
  const chars = [...clean(text).replace(/\s+/g, " ").trim()];
  return chars.length > max ? `${chars.slice(0, Math.max(0, max - 1)).join("")}…` : chars.join("");
}

export function gh(args, { timeout = GH_TIMEOUT_MS } = {}) {
  return new Promise((resolve, reject) => {
    execFile("gh", args, { maxBuffer: 16 * 1024 * 1024, timeout, env: ghEnv(process.env) }, (error, stdout, stderr) => {
      if (error) return reject(new Error(clean((stderr || error.message).trim())));
      resolve(stdout);
    });
  });
}

export async function ghGraphql(args, run = gh) {
  const stdout = await run(["api", "graphql", ...args]);
  let body;
  try {
    body = JSON.parse(stdout);
  } catch {
    throw new Error("unexpected response from gh");
  }
  if (!body?.data) throw new Error(clean(body?.errors?.[0]?.message ?? "unexpected response from gh"));
  return body.data;
}

const oidOf = (value) => (typeof value === "string" && OID.test(value) ? value : null);
const wordOf = (value) => (typeof value === "string" && WORD.test(value) ? value : null);

export function mergeFields(pr) {
  const state = wordOf(pr.viewerLatestReview?.state);
  return {
    headRefOid: oidOf(pr.headRefOid),
    reviewDecision: wordOf(pr.reviewDecision),
    mergeStateStatus: wordOf(pr.mergeStateStatus),
    checks: wordOf(pr.commits?.nodes?.[0]?.commit?.statusCheckRollup?.state),
    viewerReview: state ? { state, oid: oidOf(pr.viewerLatestReview?.commit?.oid) } : null,
  };
}

function actionOf(pr, login, reviewRequested) {
  if (reviewRequested && pr.author?.login !== login) return "review";
  if (pr.isDraft) return "draft";
  if (pr.mergeable === "CONFLICTING") return "conflict";
  const checks = pr.commits?.nodes?.[0]?.commit?.statusCheckRollup?.state;
  if (checks === "FAILURE" || checks === "ERROR") return "failing";
  if (pr.reviewDecision === "CHANGES_REQUESTED") return "changes";
  if (checks === "PENDING" || checks === "EXPECTED") return "running";
  if (pr.mergeStateStatus === "BEHIND") return "behind";
  if (["CLEAN", "HAS_HOOKS", "UNSTABLE"].includes(pr.mergeStateStatus)) return "merge";
  return "waiting";
}

export function rankPulls(items) {
  return [...items].sort((a, b) => ACTIONS.indexOf(a.action) - ACTIONS.indexOf(b.action) || String(b.updatedAt).localeCompare(String(a.updatedAt)));
}

export function diffNotable(prev, next) {
  if (!Array.isArray(prev)) return [];
  const before = new Map(prev.map((pr) => [pr.url, pr.action]));
  return next.filter((pr) => NOTABLE.has(pr.action) && before.get(pr.url) !== pr.action);
}

function fetchPulls() {
  return ghGraphql(["-f", `query=${QUERY}`]).then((data) => {
    if (typeof data?.viewer?.login !== "string") throw new Error("unexpected response from gh");
    return data;
  });
}

export function normalize(data) {
  const login = data.viewer.login;
  const byUrl = new Map();
  for (const alias of Object.keys(SEARCHES)) {
    for (const pr of data[alias]?.nodes ?? []) {
      if (!pr || !isPullUrl(pr.url) || !pr.repository || !Number.isSafeInteger(pr.number)) continue;
      const seen = byUrl.get(pr.url);
      const reviewRequested = alias === "review" || seen?.reviewRequested === true;
      byUrl.set(pr.url, {
        id: clean(`${pr.repository.nameWithOwner}#${pr.number}`),
        repo: clean(pr.repository.nameWithOwner),
        number: pr.number,
        title: clean(pr.title),
        author: clean(pr.author?.login),
        url: pr.url,
        updatedAt: clean(pr.updatedAt),
        listed: !UNLISTED.has(alias) || seen?.listed === true,
        isDraft: pr.isDraft === true,
        reviewRequested,
        mine: pr.author?.login === login,
        action: actionOf(pr, login, reviewRequested),
        ...mergeFields(pr),
      });
    }
  }
  return { login, items: rankPulls([...byUrl.values()]) };
}

function revive(items) {
  if (!Array.isArray(items)) return null;
  return items.filter((item) => item && isPullUrl(item.url) && ACTIONS.includes(item.action));
}

export function createPullsSource() {
  const cache = readJson(CACHE_FILE, { login: null, items: null, fetchedAt: 0 });
  cache.items = revive(cache.items);
  let pending = null;
  let error = null;

  return {
    items: () => cache.items,
    status: () => (pending ? "syncing" : error ? "offline" : null),
    sync(onChange, { force = false, onFetched } = {}) {
      if (pending || (!force && Date.now() - cache.fetchedAt < REFETCH_AFTER_MS)) return;
      let notable = null;
      pending = fetchPulls()
        .then((data) => {
          const next = normalize(data);
          notable = diffNotable(cache.items, next.items);
          Object.assign(cache, next, { fetchedAt: Date.now() });
          error = null;
          writeJson(CACHE_FILE, cache);
        })
        .catch((e) => (error = e.message))
        .finally(() => {
          pending = null;
          onChange();
          if (notable) onFetched?.(notable);
        });
      onChange();
    },
  };
}
