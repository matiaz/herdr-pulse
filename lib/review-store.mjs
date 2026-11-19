import fs from "node:fs";
import path from "node:path";
import { cap, isPullUrl } from "../sources/pulls.mjs";
import { readJson, STATE_DIR, writeJson } from "./store.mjs";

const FILE = "reviews.json";
const KEEP_MS = 14 * 24 * 60 * 60 * 1000;
const KEY = /^[\w:.-]{1,200}$/;
const TEXTS = ["launchError", "mergeError"];

function sanitize(fields, into = {}) {
  const out = { ...into };
  for (const name of TEXTS) {
    if (fields[name] === null) delete out[name];
    else if (typeof fields[name] === "string" && fields[name]) out[name] = cap(fields[name], 300);
  }
  if (fields.mergeKey === null) delete out.mergeKey;
  else if (typeof fields.mergeKey === "string" && KEY.test(fields.mergeKey)) out.mergeKey = fields.mergeKey;
  return out;
}

export function createReviewStore({ now = Date.now, max = 1000 } = {}) {
  const entries = new Map();
  let loadedMtime = -1;

  function mtime() {
    try {
      return fs.statSync(path.join(STATE_DIR, FILE)).mtimeMs;
    } catch {
      return 0;
    }
  }

  function trim() {
    const sorted = [...entries].sort((a, b) => a[1].startedAt - b[1].startedAt);
    while (sorted.length > max) entries.delete(sorted.shift()[0]);
  }

  function save() {
    try {
      writeJson(FILE, { entries: Object.fromEntries(entries) });
      loadedMtime = mtime();
    } catch {}
  }

  function load(force = false) {
    const current = mtime();
    if (!force && current === loadedMtime) return;
    loadedMtime = current;
    entries.clear();
    const list = readJson(FILE, null)?.entries;
    if (!list || typeof list !== "object" || Array.isArray(list)) return;
    for (const [url, entry] of Object.entries(list)) {
      if (!isPullUrl(url) || !entry || typeof entry !== "object") continue;
      if (!Number.isFinite(entry.startedAt) || !Number.isFinite(entry.lastSeen)) continue;
      entries.set(url, sanitize(entry, { startedAt: entry.startedAt, lastSeen: entry.lastSeen }));
    }
    trim();
  }

  load(true);

  return {
    has(url) {
      load();
      return entries.has(url);
    },
    get(url) {
      load();
      const entry = entries.get(url);
      return entry ? { ...entry } : null;
    },
    record(url) {
      if (!isPullUrl(url)) return;
      load(true);
      entries.delete(url);
      entries.set(url, { startedAt: now(), lastSeen: now() });
      trim();
      save();
    },
    update(url, fields) {
      load(true);
      const entry = entries.get(url);
      if (!entry || !fields || typeof fields !== "object") return;
      entries.set(url, sanitize(fields, entry));
      save();
    },
    seen(urls) {
      if (!Array.isArray(urls)) return;
      load(true);
      const present = new Set(urls);
      for (const [url, entry] of entries) {
        if (present.has(url)) entry.lastSeen = now();
        else if (now() - entry.lastSeen >= KEEP_MS) entries.delete(url);
      }
      save();
    },
  };
}
