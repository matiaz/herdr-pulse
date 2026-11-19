import { execFile } from "node:child_process";
import { cap } from "../sources/pulls.mjs";
import { setting } from "./settings.mjs";

const HERDR = process.env.HERDR_BIN_PATH || "herdr";
const MAX_TRANSITIONS = 5;

function run(args) {
  return new Promise((resolve) => {
    execFile(HERDR, args, { timeout: 15 * 1000 }, (error) => resolve(!error));
  });
}

export async function showNotification(title, body, exec = run) {
  if (setting("notifications.prs") !== true) return false;
  try {
    return await exec(["notification", "show", cap(title, 80), `--body=${cap(body, 200)}`]);
  } catch {
    return false;
  }
}

export async function notifyTransitions(notable, send = showNotification) {
  for (const item of (Array.isArray(notable) ? notable : []).slice(0, MAX_TRANSITIONS)) {
    await send(item.action === "merge" ? "Ready to merge" : "CI failed", `${item.repo}#${item.number} ${item.title}`);
  }
}
