import { cap, gh as defaultGh, ghGraphql, isPullUrl, mergeFields, PULL_URL } from "./pulls.mjs";

const OID = /^[0-9a-f]{40}$/;
const METHODS = ["squash", "merge", "rebase"];
const METHOD_NAMES = { squash: "squash merging", merge: "merge commits", rebase: "rebase merging" };
const QUERY = `query($owner: String!, $name: String!, $number: Int!) {
  repository(owner: $owner, name: $name) {
    squashMergeAllowed mergeCommitAllowed rebaseMergeAllowed
    pullRequest(number: $number) {
      url state isDraft headRefOid reviewDecision mergeStateStatus
      viewerLatestReview { state commit { oid } }
      commits(last: 1) { nodes { commit { statusCheckRollup { state } } } }
    }
  }
}`;

function parts(url) {
  const match = isPullUrl(url) ? PULL_URL.exec(url) : null;
  if (!match) throw new Error("invalid pull request url");
  return { owner: match[1], name: match[2], number: Number(match[3]) };
}

export function mergeKey(pr, method) {
  return `${pr.headRefOid}:${pr.mergeStateStatus}:${method}`;
}

export function canMerge(pr, entry, method) {
  if (!entry || entry.launchError) return false;
  if (entry.mergeKey === mergeKey(pr, method)) return false;
  if ((pr.state ?? "OPEN") !== "OPEN" || pr.isDraft === true) return false;
  if (typeof pr.headRefOid !== "string" || !pr.headRefOid) return false;
  return (
    pr.reviewDecision === "APPROVED" &&
    pr.viewerReview?.state === "APPROVED" &&
    pr.viewerReview.oid === pr.headRefOid &&
    pr.mergeStateStatus === "CLEAN" &&
    pr.checks === "SUCCESS"
  );
}

export function pickMerge(items, store, method) {
  return (Array.isArray(items) ? items : []).find((item) => canMerge(item, store.get(item.url), method)) ?? null;
}

export function createMerge({ gh = defaultGh } = {}) {
  return {
    async check(pr) {
      const { owner, name, number } = parts(pr?.url);
      const data = await ghGraphql(["-f", `query=${QUERY}`, "-f", `owner=${owner}`, "-f", `name=${name}`, "-F", `number=${number}`], gh);
      const repository = data?.repository;
      const fresh = repository?.pullRequest;
      if (!fresh || String(fresh.url).toLowerCase() !== pr.url.toLowerCase()) throw new Error("pull request not found");
      return {
        pr: { ...pr, state: cap(fresh.state, 20), isDraft: fresh.isDraft === true, ...mergeFields(fresh) },
        allowed: {
          squash: repository.squashMergeAllowed === true,
          merge: repository.mergeCommitAllowed === true,
          rebase: repository.rebaseMergeAllowed === true,
        },
      };
    },
    async merge(pr, method) {
      parts(pr?.url);
      if (!METHODS.includes(method)) throw new Error("invalid merge method");
      if (typeof pr.headRefOid !== "string" || !OID.test(pr.headRefOid)) throw new Error("invalid head commit");
      await gh(["pr", "merge", pr.url, `--${method}`, "--match-head-commit", pr.headRefOid]);
    },
  };
}

export async function autoMerge(items, { store, method, merge = createMerge(), alert = async () => {} }) {
  const pr = pickMerge(items, store, method);
  if (!pr) return null;
  const { pr: fresh, allowed } = await merge.check(pr);
  if (!canMerge(fresh, store.get(pr.url), method)) return "skipped";
  const key = mergeKey(fresh, method);
  if (allowed?.[method] !== true) {
    store.update(pr.url, { mergeError: `Not merged: this repository does not allow ${METHOD_NAMES[method]}`, mergeKey: key });
    return "not-allowed";
  }
  const label = `${pr.repo}#${pr.number}`;
  try {
    await merge.merge(fresh, method);
    store.update(pr.url, { mergeError: null, mergeKey: key });
    await alert("Pull request merged", `Pulse merged ${label}`);
    return "merged";
  } catch (error) {
    const message = cap(error?.message ?? error, 200) || "merge failed";
    store.update(pr.url, { mergeError: `Merge failed: ${message}`, mergeKey: key });
    await alert("Merge failed", `${label}: ${message}`);
    return "failed";
  }
}
