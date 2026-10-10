import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { readJson, writeJson } from "../lib/store.mjs";

const CACHE_FILE = "claude-limits.json";
const ENDPOINT = "https://api.anthropic.com/api/oauth/usage";
const KEYCHAIN_SERVICE = "Claude Code-credentials";
const REFETCH_AFTER_MS = 2 * 60 * 1000;
const BACKOFF_MS = 10 * 60 * 1000;
const TIMEOUT_MS = 10 * 1000;

function credentialsFile() {
  return path.join(process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), ".claude"), ".credentials.json");
}

function keychainCredentials() {
  if (process.platform !== "darwin") return Promise.resolve(null);
  return new Promise((resolve) => {
    execFile("security", ["find-generic-password", "-s", KEYCHAIN_SERVICE, "-w"], { timeout: TIMEOUT_MS }, (error, stdout) => resolve(error ? null : stdout));
  });
}

async function readOauth() {
  let raw = await keychainCredentials();
  if (!raw) {
    try {
      raw = fs.readFileSync(credentialsFile(), "utf8");
    } catch {
      return null;
    }
  }
  try {
    return JSON.parse(raw)?.claudeAiOauth ?? null;
  } catch {
    return null;
  }
}

function windowOf(entry) {
  if (!entry || typeof entry.utilization !== "number") return null;
  return { percent: entry.utilization, resetsAt: entry.resets_at ?? null };
}

export function createLimitsSource() {
  const cache = readJson(CACHE_FILE, { session: null, weekly: null, fetchedAt: 0 });
  let pending = null;
  let error = null;
  let nextAt = 0;

  async function fetchLimits() {
    const oauth = await readOauth();
    if (!oauth?.accessToken) throw new Error("sign in to claude to see plan usage");
    if (oauth.expiresAt && oauth.expiresAt < Date.now()) throw new Error("open claude to refresh plan usage");
    const response = await fetch(ENDPOINT, {
      headers: { Authorization: `Bearer ${oauth.accessToken}`, "anthropic-beta": "oauth-2025-04-20" },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (response.status === 401) throw new Error("open claude to refresh plan usage");
    if (response.status === 429) {
      nextAt = Date.now() + BACKOFF_MS;
      throw new Error("plan usage rate limited");
    }
    if (!response.ok) throw new Error("plan usage unavailable");
    const body = await response.json();
    cache.session = windowOf(body.five_hour);
    cache.weekly = windowOf(body.seven_day);
    cache.fetchedAt = Date.now();
    writeJson(CACHE_FILE, cache);
  }

  return {
    session: () => cache.session,
    weekly: () => cache.weekly,
    error: () => error,
    loading: () => Boolean(pending) && !cache.fetchedAt,
    sync(onChange, { force = false } = {}) {
      if (pending) return;
      if (!force && (Date.now() < nextAt || Date.now() - cache.fetchedAt < REFETCH_AFTER_MS)) return;
      nextAt = Date.now() + REFETCH_AFTER_MS;
      pending = fetchLimits()
        .then(() => (error = null))
        .catch((e) => (error = e.name === "TimeoutError" || e.name === "TypeError" ? "plan usage offline" : e.message))
        .finally(() => {
          pending = null;
          onChange();
        });
    },
  };
}
