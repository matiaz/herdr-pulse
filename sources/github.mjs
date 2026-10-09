import { execFile } from "node:child_process";
import { addDays, eachDay, isoDay, readJson, writeJson } from "../lib/store.mjs";
import { clean } from "../lib/term.mjs";

const CACHE_FILE = "github.json";
const REFETCH_AFTER_MS = 10 * 60 * 1000;
const MAX_QUERY_DAYS = 364;
const LEVELS = { NONE: 0, FIRST_QUARTILE: 1, SECOND_QUARTILE: 2, THIRD_QUARTILE: 3, FOURTH_QUARTILE: 4 };
const QUERY = `query($from: DateTime!, $to: DateTime!) {
  viewer {
    login
    contributionsCollection(from: $from, to: $to) {
      contributionCalendar { weeks { contributionDays { date contributionCount contributionLevel } } }
    }
  }
}`;

function gh(from, to) {
  const args = ["api", "graphql", "-f", `query=${QUERY}`, "-f", `from=${isoDay(from)}T00:00:00`, "-f", `to=${isoDay(to)}T23:59:59`];
  return new Promise((resolve, reject) => {
    execFile("gh", args, { maxBuffer: 16 * 1024 * 1024 }, (error, stdout, stderr) => {
      if (error) return reject(new Error(clean((stderr || error.message).trim())));
      try {
        const viewer = JSON.parse(stdout).data?.viewer;
        if (!viewer) throw new Error("unexpected response from gh");
        resolve(viewer);
      } catch (parseError) {
        reject(parseError);
      }
    });
  });
}

export function createGithubSource() {
  const cache = readJson(CACHE_FILE, { login: null, days: {}, recentAt: 0 });
  let pending = null;
  let error = null;

  async function fetchRange(start, end) {
    for (let from = start; from <= end; from = addDays(from, MAX_QUERY_DAYS + 1)) {
      const chunkEnd = addDays(from, MAX_QUERY_DAYS);
      const viewer = await gh(from, chunkEnd < end ? chunkEnd : end);
      cache.login = clean(viewer.login);
      for (const week of viewer.contributionsCollection.contributionCalendar.weeks) {
        for (const day of week.contributionDays) cache.days[day.date] = [day.contributionCount, LEVELS[day.contributionLevel] ?? 0];
      }
    }
  }

  function needsFetch(start, end, force) {
    if (force) return true;
    if (isoDay(end) === isoDay(new Date()) && Date.now() - cache.recentAt > REFETCH_AFTER_MS) return true;
    let missing = false;
    eachDay(start, end, (day) => (missing ||= !(day in cache.days)));
    return missing;
  }

  return {
    name: "github",
    title: () => `github · ${cache.login ?? "…"}`,
    value: (day) => cache.days[day]?.[0] ?? 0,
    level: (day) => cache.days[day]?.[1] ?? 0,
    formatTotal: (total) => `${total.toLocaleString("en-US")} contribution${total === 1 ? "" : "s"}`,
    status: () => (pending ? "syncing" : error ? "offline" : null),
    sync(start, end, onChange, { force = false } = {}) {
      if (pending || !needsFetch(start, end, force)) return;
      pending = fetchRange(start, end)
        .then(() => {
          error = null;
          if (isoDay(end) === isoDay(new Date())) cache.recentAt = Date.now();
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
