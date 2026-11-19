import { execFile } from "node:child_process";
import { ACTIONS } from "../sources/pulls.mjs";
import { setting } from "./settings.mjs";
import { readJson } from "./store.mjs";

const HERDR = process.env.HERDR_BIN_PATH || "herdr";
const SOURCE = "matiaz.pulse";
const TOKEN = "pulse";
const LIMITS_FILE = "claude-limits.json";
const LABELS = {
  merge: (n) => `${n} to merge`,
  failing: (n) => `${n} CI failed`,
  conflict: (n) => `${n} with conflicts`,
  changes: (n) => `${n} need changes`,
  behind: (n) => `${n} to update`,
  review: (n) => `${n} to review`,
};

function run(args) {
  return new Promise((resolve) => {
    execFile(HERDR, args, { timeout: 15 * 1000 }, (error) => resolve(!error));
  });
}

export function statusText(items, percent) {
  const counts = {};
  for (const item of Array.isArray(items) ? items : []) counts[item.action] = (counts[item.action] ?? 0) + 1;
  const top = ACTIONS.find((action) => LABELS[action] && counts[action] > 0);
  const parts = [top ? LABELS[top](counts[top]) : null, Number.isFinite(percent) ? `5h ${Math.round(percent)}%` : null];
  return parts.filter(Boolean).join(" · ");
}

export function planPercent() {
  if (setting("claude.planLimits") !== true) return null;
  const session = readJson(LIMITS_FILE, {})?.session;
  if (!Number.isFinite(session?.percent)) return null;
  const resetsAt = Date.parse(session.resetsAt ?? "");
  if (!Number.isFinite(resetsAt)) return null;
  return resetsAt > Date.now() ? session.percent : 0;
}

export function createStatusToken({ exec = run } = {}) {
  const last = new Map();
  return {
    async report(repos, items, percent = planPercent()) {
      for (const id of last.keys()) if (!repos.has(id)) last.delete(id);
      for (const [id, slugs] of repos) {
        const text = statusText(items.filter((item) => slugs.has(String(item.repo).toLowerCase())), percent);
        if (last.get(id) === text) continue;
        const patch = text ? ["--token", `${TOKEN}=${text}`] : ["--clear-token", TOKEN];
        try {
          if (await exec(["workspace", "report-metadata", id, "--source", SOURCE, ...patch])) last.set(id, text);
        } catch {}
      }
    },
  };
}
