import { execFile } from "node:child_process";
import { readJson, writeJson } from "../lib/store.mjs";
import { clean } from "../lib/term.mjs";

const CACHE_FILE = "pulls.json";
const REFETCH_AFTER_MS = 2 * 60 * 1000;
const SEARCHES = {
  authored: "is:pr is:open archived:false author:@me",
  assigned: "is:pr is:open archived:false assignee:@me",
  review: "is:pr is:open archived:false review-requested:@me",
};
const QUERY = `query {
  viewer { login }
  ${Object.entries(SEARCHES).map(([alias, q]) => `${alias}: search(query: "${q}", type: ISSUE, first: 50) { nodes { ...pr } }`).join("\n  ")}
}
fragment pr on PullRequest {
  number title url isDraft updatedAt reviewDecision mergeable mergeStateStatus
  author { login }
  repository { nameWithOwner }
  commits(last: 1) { nodes { commit { statusCheckRollup { state } } } }
}`;

export const ACTIONS = ["merge", "failing", "conflict", "changes", "behind", "review", "running", "waiting", "draft"];

function actionOf(pr, login, reviewRequested) {
  if (reviewRequested && pr.author?.login !== login) return "review";
  if (pr.isDraft) return "draft";
  if (pr.mergeable === "CONFLICTING") return "conflict";
  const checks = pr.commits.nodes[0]?.commit.statusCheckRollup?.state;
  if (checks === "FAILURE" || checks === "ERROR") return "failing";
  if (pr.reviewDecision === "CHANGES_REQUESTED") return "changes";
  if (checks === "PENDING" || checks === "EXPECTED") return "running";
  if (pr.mergeStateStatus === "BEHIND") return "behind";
  if (["CLEAN", "HAS_HOOKS", "UNSTABLE"].includes(pr.mergeStateStatus)) return "merge";
  return "waiting";
}

function fetchPulls() {
  return new Promise((resolve, reject) => {
    execFile("gh", ["api", "graphql", "-f", `query=${QUERY}`], { maxBuffer: 16 * 1024 * 1024 }, (error, stdout, stderr) => {
      if (error) return reject(new Error(clean((stderr || error.message).trim())));
      try {
        const data = JSON.parse(stdout).data;
        if (!data?.viewer) throw new Error("unexpected response from gh");
        resolve(data);
      } catch (parseError) {
        reject(parseError);
      }
    });
  });
}

function normalize(data) {
  const login = data.viewer.login;
  const byUrl = new Map();
  for (const alias of Object.keys(SEARCHES)) {
    for (const pr of data[alias]?.nodes ?? []) {
      if (!pr?.url || !pr.repository) continue;
      const seen = byUrl.get(pr.url);
      const reviewRequested = alias === "review" || seen?.reviewRequested;
      byUrl.set(pr.url, {
        id: clean(`${pr.repository.nameWithOwner}#${pr.number}`),
        repo: clean(pr.repository.nameWithOwner),
        number: pr.number,
        title: clean(pr.title),
        url: pr.url,
        updatedAt: pr.updatedAt,
        reviewRequested,
        action: actionOf(pr, login, reviewRequested),
      });
    }
  }
  const items = [...byUrl.values()].sort(
    (a, b) => ACTIONS.indexOf(a.action) - ACTIONS.indexOf(b.action) || b.updatedAt.localeCompare(a.updatedAt),
  );
  return { login, items };
}

export function createPullsSource() {
  const cache = readJson(CACHE_FILE, { login: null, items: null, fetchedAt: 0 });
  let pending = null;
  let error = null;

  return {
    items: () => cache.items,
    status: () => (pending ? "syncing" : error ? "offline" : null),
    sync(onChange, { force = false } = {}) {
      if (pending || (!force && Date.now() - cache.fetchedAt < REFETCH_AFTER_MS)) return;
      pending = fetchPulls()
        .then((data) => {
          Object.assign(cache, normalize(data), { fetchedAt: Date.now() });
          error = null;
          writeJson(CACHE_FILE, cache);
        })
        .catch((e) => (error = e.message))
        .finally(() => {
          pending = null;
          onChange();
        });
      onChange();
    },
  };
}
