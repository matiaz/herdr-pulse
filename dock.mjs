import { spawnSync } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";
import { PLUGIN_ID, readJson } from "./lib/store.mjs";

const HERDR = process.env.HERDR_BIN_PATH || "herdr";
const TITLE_MARKER = /^herdr-pulse \d+$/;
const DEFAULT_COLUMNS = 45;
const FRAME_COLUMNS = 2;
const MIN_COLUMNS = 30;
const MAX_SWAPS = 8;
const STARTUP_WAIT_MS = 60 * 1000;
const STARTUP_POLL_MS = 1000;

function herdr(...args) {
  const result = spawnSync(HERDR, args, { encoding: "utf8", timeout: 15 * 1000 });
  if (result.status !== 0) return null;
  try {
    return result.stdout.trim() ? JSON.parse(result.stdout) : {};
  } catch {
    return null;
  }
}

function focusedPane() {
  const context = JSON.parse(process.env.HERDR_PLUGIN_CONTEXT_JSON || "{}");
  const paneId = process.env.HERDR_PANE_ID || context.focused_pane_id;
  const tabId = process.env.HERDR_TAB_ID || context.tab_id;
  if (paneId && tabId) return { paneId, tabId };
  const pane = herdr("pane", "current")?.result?.pane;
  return pane ? { paneId: pane.pane_id, tabId: pane.tab_id } : null;
}

function docksIn(tabId) {
  const panes = herdr("pane", "list")?.result?.panes ?? [];
  return panes.filter((pane) => pane.tab_id === tabId && TITLE_MARKER.test(pane.terminal_title ?? ""));
}

function rightmostPane(paneId) {
  const layout = herdr("pane", "layout", "--pane", paneId)?.result?.layout;
  if (!layout) return paneId;
  const edge = Math.max(...layout.panes.map(({ rect }) => rect.x + rect.width));
  const atEdge = layout.panes.filter(({ rect }) => rect.x + rect.width === edge);
  return (atEdge.find((pane) => pane.pane_id === paneId) ?? atEdge[0])?.pane_id ?? paneId;
}

function resizeToColumns(dockId, columns) {
  const layout = herdr("pane", "layout", "--pane", dockId)?.result?.layout;
  const rect = layout?.panes.find((pane) => pane.pane_id === dockId)?.rect;
  if (!rect || !layout.area.width) return;
  const amount = (rect.width - columns - FRAME_COLUMNS) / layout.area.width;
  if (amount > 0) herdr("pane", "resize", "--direction", "right", "--amount", amount.toFixed(3), "--pane", dockId);
  if (amount < 0) herdr("pane", "resize", "--direction", "left", "--amount", (-amount).toFixed(3), "--pane", dockId);
}

function openDock(paneId) {
  const columns = Math.max(MIN_COLUMNS, readJson("view.json", {}).width ?? DEFAULT_COLUMNS);
  const opened = herdr(
    "plugin", "pane", "open",
    "--plugin", PLUGIN_ID,
    "--entrypoint", "dock",
    "--placement", "split",
    "--direction", "right",
    "--target-pane", rightmostPane(paneId),
    "--no-focus",
  );
  const dockId = opened?.result?.pane?.pane_id ?? JSON.stringify(opened ?? {}).match(/"pane_id":"([^"]+)"/)?.[1];
  if (!dockId) return;
  for (let i = 0; i < MAX_SWAPS; i++) {
    const neighbor = herdr("pane", "neighbor", "--direction", "right", "--pane", dockId);
    if (!JSON.stringify(neighbor ?? {}).includes("pane_id")) break;
    if (!herdr("pane", "swap", "--direction", "right", "--pane", dockId)) break;
  }
  resizeToColumns(dockId, columns);
  herdr("pane", "focus", "--direction", "left", "--pane", dockId);
}

async function waitForFocus() {
  const deadline = Date.now() + STARTUP_WAIT_MS;
  while (Date.now() < deadline) {
    const focus = focusedPane();
    if (focus) return focus;
    await sleep(STARTUP_POLL_MS);
  }
  return null;
}

const mode = process.argv[2] ?? "toggle";
const focus = mode === "open" ? await waitForFocus() : focusedPane();
if (focus) {
  const docks = docksIn(focus.tabId);
  if (mode === "toggle" && docks.length) {
    for (const dock of docks) herdr("pane", "close", dock.pane_id);
  } else if (!docks.length) {
    openDock(focus.paneId);
  }
}
