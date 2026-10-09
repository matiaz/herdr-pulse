import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { isoDay, quartileLevels, readJson, writeJson } from "../lib/store.mjs";

const SCAN_FILE = "claude-scan.json";
const HISTORY_FILE = "claude-history.json";
const RESCAN_AFTER_MS = 30 * 1000;
const PRICES = Object.entries({
  "claude-fable-5-1": [10, 50, 0.25],
  "claude-fable-5": [10, 50, 1],
  "claude-opus-5-5": [4, 20, 0.2],
  "claude-opus-5": [5, 25, 0.5],
  "claude-opus-4-8": [5, 25, 0.5],
  "claude-opus-4-7": [5, 25, 0.5],
  "claude-opus-4-6": [5, 25, 0.5],
  "claude-sonnet-5-5": [2, 10, 0.2],
  "claude-sonnet-5": [2, 10, 0.2],
  "claude-sonnet-4-6": [3, 15, 0.3],
  "claude-haiku-4-5": [1, 5, 0.1],
}).sort(([a], [b]) => b.length - a.length);

function priceFor(model) {
  return PRICES.find(([prefix]) => model?.startsWith(prefix))?.[1];
}

function costOf(model, usage) {
  const price = priceFor(model);
  if (!price) return 0;
  const [input, output, cacheRead] = price;
  const written = usage.cache_creation_input_tokens || 0;
  const oneHour = usage.cache_creation?.ephemeral_1h_input_tokens ?? 0;
  const fiveMinutes = usage.cache_creation ? usage.cache_creation.ephemeral_5m_input_tokens ?? 0 : written;
  const dollars = ((usage.input_tokens || 0) * input
    + (usage.output_tokens || 0) * output
    + fiveMinutes * input * 1.25
    + oneHour * input * 2
    + (usage.cache_read_input_tokens || 0) * cacheRead) / 1e6;
  return usage.speed === "fast" ? dollars * 2 : dollars;
}

function transcriptsRoot() {
  return path.join(process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), ".claude"), "projects");
}

function listTranscripts(root) {
  try {
    return fs.readdirSync(root, { recursive: true }).filter((name) => name.endsWith(".jsonl")).map((name) => path.join(root, name));
  } catch {
    return [];
  }
}

function readCompleteLines(file, from, to) {
  const fd = fs.openSync(file, "r");
  try {
    const buffer = Buffer.alloc(to - from);
    fs.readSync(fd, buffer, 0, buffer.length, from);
    const lastNewline = buffer.lastIndexOf(0x0a);
    if (lastNewline < 0) return { lines: [], consumed: 0 };
    return { lines: buffer.subarray(0, lastNewline).toString("utf8").split("\n"), consumed: lastNewline + 1 };
  } finally {
    fs.closeSync(fd);
  }
}

function scanTranscript(file, size, known) {
  if (known && known.o === size) return known;
  const resume = known && known.o < size;
  const entries = resume ? known.e : [];
  const from = resume ? known.o : 0;
  const { lines, consumed } = readCompleteLines(file, from, size);
  for (const line of lines) {
    if (!line.includes('"usage"')) continue;
    let record;
    try {
      record = JSON.parse(line);
    } catch {
      continue;
    }
    const usage = record?.message?.usage;
    if (record.type !== "assistant" || !usage || !record.timestamp || !record.message.id) continue;
    entries.push([`${record.message.id}:${record.requestId}`, isoDay(new Date(record.timestamp)), costOf(record.message.model, usage)]);
  }
  return { o: from + consumed, e: entries };
}

export function createClaudeSource() {
  const history = readJson(HISTORY_FILE, { days: {} });
  let levelOf = quartileLevels(Object.values(history.days));
  let scannedAt = 0;

  function scan() {
    const previous = readJson(SCAN_FILE, {});
    const next = {};
    let changed = false;
    for (const file of listTranscripts(transcriptsRoot())) {
      try {
        next[file] = scanTranscript(file, fs.statSync(file).size, previous[file]);
        changed ||= next[file].o !== previous[file]?.o;
      } catch {
        if (previous[file]) next[file] = previous[file];
      }
    }
    changed ||= Object.keys(previous).some((file) => !(file in next));
    if (!changed) return;
    const byMessage = new Map();
    for (const { e } of Object.values(next)) {
      for (const [key, day, cost] of e) {
        const seen = byMessage.get(key);
        if (!seen || seen[1] < cost) byMessage.set(key, [day, cost]);
      }
    }
    const daily = {};
    for (const [day, cost] of byMessage.values()) daily[day] = (daily[day] || 0) + cost;
    for (const [day, cost] of Object.entries(daily)) history.days[day] = Math.max(history.days[day] || 0, cost);
    levelOf = quartileLevels(Object.values(history.days));
    writeJson(SCAN_FILE, next);
    writeJson(HISTORY_FILE, history);
  }

  return {
    name: "claude",
    title: () => "claude code",
    value: (day) => history.days[day] || 0,
    level: (day) => levelOf(history.days[day] || 0),
    formatTotal: (total) => `$${total.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`,
    status: () => null,
    sync(start, end, onChange, { force = false } = {}) {
      if (!force && Date.now() - scannedAt < RESCAN_AFTER_MS) return;
      scannedAt = Date.now();
      try {
        scan();
      } catch {}
      onChange();
    },
  };
}
