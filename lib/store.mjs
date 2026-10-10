import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const PLUGIN_ID = process.env.HERDR_PLUGIN_ID || "matiaz.pulse";
export const STATE_DIR = process.env.HERDR_PLUGIN_STATE_DIR || path.join(os.homedir(), ".local", "state", PLUGIN_ID);

fs.mkdirSync(STATE_DIR, { recursive: true, mode: 0o700 });
fs.chmodSync(STATE_DIR, 0o700);

export function readJson(name, fallback) {
  try {
    return JSON.parse(fs.readFileSync(path.join(STATE_DIR, name), "utf8"));
  } catch {
    return fallback;
  }
}

export function writeJson(name, value) {
  const file = path.join(STATE_DIR, name);
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value), { mode: 0o600 });
  fs.renameSync(tmp, file);
}

export function isoDay(date) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

export function addDays(date, days) {
  const next = new Date(date);
  next.setDate(next.getDate() + days);
  return next;
}

export function eachDay(start, end, fn) {
  for (let day = new Date(start); day <= end; day = addDays(day, 1)) fn(isoDay(day));
}

export function quartileLevels(values) {
  const sorted = values.filter((v) => v > 0).sort((a, b) => a - b);
  const at = (q) => sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))];
  const [q1, q2, q3] = sorted.length ? [at(0.25), at(0.5), at(0.75)] : [0, 0, 0];
  return (value) => {
    if (!value) return 0;
    if (value <= q1) return 1;
    if (value <= q2) return 2;
    if (value <= q3) return 3;
    return 4;
  };
}
