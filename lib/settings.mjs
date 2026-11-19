import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PLUGIN_ID } from "./store.mjs";

export const CONFIG_DIR = process.env.HERDR_PLUGIN_CONFIG_DIR || path.join(os.homedir(), ".config", "herdr", "plugins", "config", PLUGIN_ID);
export const CONFIG_FILE = path.join(CONFIG_DIR, "config.json");

const SCHEMA = {
  "claude.planLimits": { type: "boolean", default: true },
  "heatmap.defaultSource": { type: "enum", values: ["github", "claude"], default: "github" },
  "notifications.prs": { type: "boolean", default: true },
  "git.aiMessages": { type: "boolean", default: true },
  "claude.configDir": { type: "path", default: "" },
  "pulls.scope": { type: "enum", values: ["workspace", "open", "all"], default: "open" },
  "reviews.auto": { type: "boolean", default: true },
  "reviews.autoApprove": { type: "boolean", default: false },
  "reviews.autoMerge": { type: "boolean", default: false },
  "reviews.mergeMethod": { type: "enum", values: ["squash", "merge", "rebase"], default: "squash" },
  "reviews.loopMinutes": { type: "integer", min: 1, max: 1440, default: 10 },
};

export const SETTING_KEYS = Object.keys(SCHEMA);

function valid(spec, value) {
  if (spec.type === "boolean") return typeof value === "boolean";
  if (spec.type === "enum") return spec.values.includes(value);
  if (spec.type === "integer") return Number.isInteger(value) && value >= spec.min && value <= spec.max;
  if (spec.type === "path") return typeof value === "string" && (value === "" || path.isAbsolute(value));
  return false;
}

function flatten(raw) {
  const out = {};
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return out;
  for (const [key, value] of Object.entries(raw)) {
    if (value && typeof value === "object" && !Array.isArray(value)) {
      for (const [inner, innerValue] of Object.entries(value)) out[`${key}.${inner}`] = innerValue;
    } else out[key] = value;
  }
  return out;
}

export function parseSettings(raw) {
  const flat = flatten(raw);
  const settings = {};
  for (const [key, spec] of Object.entries(SCHEMA)) settings[key] = key in flat && valid(spec, flat[key]) ? flat[key] : spec.default;
  return settings;
}

let cache = { mtime: -1, settings: parseSettings({}) };

export function getSettings() {
  let mtime = 0;
  try {
    mtime = fs.statSync(CONFIG_FILE).mtimeMs;
  } catch {
    mtime = 0;
  }
  if (mtime === cache.mtime) return cache.settings;
  let raw = {};
  if (mtime) {
    try {
      raw = JSON.parse(fs.readFileSync(CONFIG_FILE, "utf8"));
    } catch {
      raw = {};
    }
  }
  cache = { mtime, settings: parseSettings(raw) };
  return cache.settings;
}

export function setting(key) {
  return getSettings()[key];
}
