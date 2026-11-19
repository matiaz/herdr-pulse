import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { setting } from "../lib/settings.mjs";
import { readJson, writeJson } from "../lib/store.mjs";

const CACHE_FILE = "claude-limits.json";
const ENDPOINT = "https://api.anthropic.com/api/oauth/usage";
const KEYCHAIN_SERVICE = "Claude Code-credentials";
const SECURITY_BIN = "/usr/bin/security";
const REFETCH_AFTER_MS = 2 * 60 * 1000;
const BACKOFF_MS = 10 * 60 * 1000;
const TIMEOUT_MS = 10 * 1000;
const TOKEN_PATTERN = /^[\x21-\x7e]{1,4096}$/;

export function claudeConfigDir() {
  const usable = (value) => typeof value === "string" && value.trim() && path.isAbsolute(value.trim());
  const configured = setting("claude.configDir");
  if (usable(configured)) return configured.trim();
  if (usable(process.env.CLAUDE_CONFIG_DIR)) return process.env.CLAUDE_CONFIG_DIR.trim();
  return path.join(os.homedir(), ".claude");
}

export const planLimitsEnabled = () => setting("claude.planLimits") === true;

function credentialsFile() {
  return path.join(claudeConfigDir(), ".credentials.json");
}

function keychainCredentials() {
  if (process.platform !== "darwin") return Promise.resolve(null);
  return new Promise((resolve) => {
    execFile(SECURITY_BIN, ["find-generic-password", "-s", KEYCHAIN_SERVICE, "-w"], { timeout: TIMEOUT_MS }, (error, stdout) => resolve(error ? null : stdout));
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
  const cache = { session: null, weekly: null, fetchedAt: 0, backoffUntil: 0, ...readJson(CACHE_FILE, {}) };
  let pending = null;
  let error = Date.now() < cache.backoffUntil && typeof cache.error === "string" ? cache.error : null;
  let nextAt = 0;

  function backoff(message) {
    cache.backoffUntil = Date.now() + BACKOFF_MS;
    cache.error = message;
    nextAt = cache.backoffUntil;
    writeJson(CACHE_FILE, cache);
    return new Error(message);
  }

  async function fetchLimits() {
    const oauth = await readOauth();
    let token = oauth?.accessToken;
    if (typeof token !== "string" || !TOKEN_PATTERN.test(token)) throw new Error("sign in to claude to see plan usage");
    if (oauth.expiresAt && oauth.expiresAt < Date.now()) throw new Error("open claude to refresh plan usage");
    const response = await fetch(ENDPOINT, {
      headers: { Authorization: `Bearer ${token}`, "anthropic-beta": "oauth-2025-04-20" },
      redirect: "error",
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    token = null;
    if (response.status === 401 || response.status === 403) throw backoff("open claude to refresh plan usage");
    if (response.status === 429) throw backoff("plan usage rate limited");
    if (!response.ok) throw new Error("plan usage unavailable");
    const body = await response.json();
    cache.session = windowOf(body.five_hour);
    cache.weekly = windowOf(body.seven_day);
    cache.fetchedAt = Date.now();
    cache.backoffUntil = 0;
    cache.error = null;
    writeJson(CACHE_FILE, cache);
  }

  return {
    session: () => (planLimitsEnabled() ? cache.session : null),
    weekly: () => (planLimitsEnabled() ? cache.weekly : null),
    error: () => (planLimitsEnabled() ? error : null),
    loading: () => planLimitsEnabled() && Boolean(pending) && !cache.fetchedAt,
    sync(onChange, { force = false } = {}) {
      if (pending || !planLimitsEnabled()) return;
      const now = Date.now();
      if (now < cache.backoffUntil) return;
      if (!force && (now < nextAt || now - cache.fetchedAt < REFETCH_AFTER_MS)) return;
      nextAt = now + REFETCH_AFTER_MS;
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
