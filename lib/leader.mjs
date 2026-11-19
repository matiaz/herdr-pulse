import fs from "node:fs";
import path from "node:path";
import { STATE_DIR } from "./store.mjs";

const FILE = path.join(STATE_DIR, "automation.lock");
const STALE_MS = 10 * 60 * 1000;

function alive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === "EPERM";
  }
}

function read() {
  try {
    const lock = JSON.parse(fs.readFileSync(FILE, "utf8"));
    return lock && typeof lock === "object" ? lock : null;
  } catch {
    return null;
  }
}

function write(flags) {
  const fd = fs.openSync(FILE, flags, 0o600);
  try {
    fs.writeSync(fd, JSON.stringify({ pid: process.pid, at: Date.now() }));
  } finally {
    fs.closeSync(fd);
  }
}

export function claimLeader() {
  const lock = read();
  try {
    if (lock?.pid === process.pid) write("w");
    else if (!lock) write("wx");
    else if (!alive(lock.pid) || !(Date.now() - lock.at < STALE_MS)) {
      fs.rmSync(FILE, { force: true });
      write("wx");
    } else return false;
  } catch {
    return false;
  }
  return read()?.pid === process.pid;
}

export function releaseLeader() {
  try {
    if (read()?.pid === process.pid) fs.rmSync(FILE, { force: true });
  } catch {}
}
