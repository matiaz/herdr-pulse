import { readJson, writeJson } from "./lib/store.mjs";
import { color, fit, RESET, THEME, width } from "./lib/term.mjs";
import { createGitSection } from "./sections/git.mjs";
import { createHeatmapSection } from "./sections/heatmap.mjs";
import { createPullsSection } from "./sections/pulls.mjs";

const TITLE_MARKER = `herdr-pulse ${process.pid}`;
const POLL_MS = 60 * 1000;

const view = { source: "github", offset: 0, order: [], ...readJson("view.json", {}) };
const save = () => writeJson("view.json", view);

let renderQueued = false;
function requestRender() {
  if (renderQueued) return;
  renderQueued = true;
  setImmediate(() => {
    renderQueued = false;
    render();
  });
}

const sections = [
  createHeatmapSection({ view, save, onChange: requestRender }),
  createPullsSection({ onChange: requestRender }),
  createGitSection({ selfMarker: TITLE_MARKER, onChange: requestRender }),
];
const byId = Object.fromEntries(sections.map((section) => [section.id, section]));
view.order = [...view.order.filter((id) => byId[id]), ...sections.map((s) => s.id).filter((id) => !view.order.includes(id))];

let regions = [];
let pointer = null;
let drag = null;

const BORDER = "#444c56";
const columnsNow = () => (process.stdout.columns || 41) - 1;
const arrowsColumn = () => columnsNow() - 6;

function visibleOrder() {
  return view.order.filter((id) => byId[id].visible?.() ?? true);
}

function highlighted(section) {
  return drag && (drag.id === section.id || drag.over === section.id);
}

function topBorder(section, index, count) {
  const columns = columnsNow();
  const room = Math.max(0, columns - 11);
  const title = fit(section.title(), room);
  const status = section.status();
  const statusText = status ? fit(` · ${status}`, Math.max(0, room - width(title))) : "";
  const fill = Math.max(0, room - width(title) - width(statusText));
  const edge = color(highlighted(section) ? THEME.blue : BORDER);
  const up = color(index > 0 ? THEME.muted : THEME.empty);
  const down = color(index < count - 1 ? THEME.muted : THEME.empty);
  return `${edge}╭─ ${color(highlighted(section) ? THEME.blue : THEME.text)}${title}${color(THEME.muted)}${statusText} ${edge}${"─".repeat(fill)} ${up}↑ ${down}↓ ${edge}─╮${RESET}`;
}

function boxed(section, line) {
  const edge = color(highlighted(section) ? THEME.blue : BORDER);
  return `${edge}│${RESET}${line}${" ".repeat(Math.max(0, columnsNow() - 2 - width(line)))}${edge}│${RESET}`;
}

function bottomBorder(section) {
  return `${color(highlighted(section) ? THEME.blue : BORDER)}╰${"─".repeat(Math.max(0, columnsNow() - 2))}╯${RESET}`;
}

function render() {
  const columns = columnsNow() - 2;
  const rows = process.stdout.rows || 40;
  const ordered = visibleOrder().map((id) => byId[id]);
  const bodies = new Map();
  for (const section of ordered) if (!section.flex) bodies.set(section.id, section.render(columns));
  const used = ordered.length * 2 + [...bodies.values()].reduce((n, lines) => n + lines.length, 0);
  const flexible = ordered
    .filter((section) => section.flex)
    .map((section) => ({ section, want: section.desiredRows?.(columns) ?? Infinity }))
    .sort((a, b) => a.want - b.want);
  let remaining = rows - used;
  flexible.forEach(({ section, want }, i) => {
    const share = Math.max(3, Math.min(want, Math.floor(remaining / (flexible.length - i))));
    remaining -= share;
    bodies.set(section.id, section.render(columns, share));
  });

  const lines = [];
  regions = [];
  ordered.forEach((section, index) => {
    const top = lines.length + 1;
    lines.push(topBorder(section, index, ordered.length));
    for (const line of bodies.get(section.id)) lines.push(boxed(section, line));
    lines.push(bottomBorder(section));
    regions.push({ section, top, bottom: lines.length });
  });

  const screen = lines.slice(0, rows);
  process.stdout.write(`\x1b[H${screen.map((line) => `${line}\x1b[K`).join("\r\n")}\x1b[J`);
}

function regionAt(y) {
  return regions.find((region) => y >= region.top && y <= region.bottom);
}

function moveTo(id, targetId) {
  if (!targetId || targetId === id) return;
  const to = view.order.indexOf(targetId);
  view.order.splice(view.order.indexOf(id), 1);
  view.order.splice(to, 0, id);
  save();
  requestRender();
}

function updateHover() {
  for (const { section, top, bottom } of regions) {
    const inside = pointer && pointer.y > top && pointer.y < bottom;
    section.hover(inside ? { x: pointer.x - 1, row: pointer.y - top - 1 } : null);
  }
}

function handleMouse(button, x, y, release) {
  const kind = button & ~(4 | 8 | 16);
  const region = regionAt(y);
  if (kind & 64) {
    if (region && !release) region.section.wheel(kind === 64 || kind === 66 ? -1 : 1);
    return;
  }
  if (kind & 32) {
    pointer = { x, y };
    if (drag) drag.over = region?.section.id ?? null;
    updateHover();
    return requestRender();
  }
  if ((kind & 3) !== 0) return;
  if (release) {
    if (!drag) return;
    const { id } = drag;
    drag = null;
    if (region) moveTo(id, region.section.id);
    return requestRender();
  }
  if (!region) return;
  if (y === region.top) {
    const visible = visibleOrder();
    const index = visible.indexOf(region.section.id);
    if (x === arrowsColumn() + 1) return moveTo(region.section.id, visible[index - 1]);
    if (x === arrowsColumn() + 3) return moveTo(region.section.id, visible[index + 1]);
    drag = { id: region.section.id, over: region.section.id };
    return requestRender();
  }
  if (y < region.bottom) region.section.click(x - 1, y - region.top - 1);
}

function syncAll(force = false) {
  for (const section of sections) section.sync(force);
}

let pendingInput = "";

function handleInput(data) {
  let text = pendingInput + data.toString("utf8");
  const partial = text.match(/\x1b(\[[<\d;?]*|O)?$/);
  pendingInput = partial ? partial[0] : "";
  if (partial) text = text.slice(0, -partial[0].length);
  for (const [token, button, x, y, kind] of text.matchAll(/\x1b\[<(\d+);(\d+);(\d+)([Mm])|\x1b\[[\d;?]*[A-Za-z~]|\x1bO[A-D]|\x1b|[^\x1b]/gs)) {
    if (button) handleMouse(Number(button), Number(x), Number(y), kind === "m");
    else if (token === "r") syncAll(true);
    else if (token === "q" || token === "\x03") shutdown();
    else for (const section of sections) section.key(token);
  }
}

let restored = false;

function restoreTerminal() {
  if (restored) return;
  restored = true;
  try {
    process.stdout.write("\x1b[?1006l\x1b[?1003l\x1b[?1000l\x1b[?25h\x1b[?1049l");
  } catch {}
}

function shutdown() {
  process.exit(0);
}

function crash(error) {
  restoreTerminal();
  console.error(error);
  process.exit(1);
}

process.stdout.write(`\x1b]0;${TITLE_MARKER}\x07\x1b[?1049h\x1b[?25l\x1b[?1000h\x1b[?1003h\x1b[?1006h`);
process.stdin.setRawMode(true);
process.stdin.on("data", handleInput);
process.stdout.on("resize", () => {
  view.width = process.stdout.columns;
  save();
  render();
  syncAll();
});
process.on("exit", restoreTerminal);
process.on("uncaughtException", crash);
process.on("unhandledRejection", crash);
process.stdout.on("error", shutdown);
process.on("SIGTERM", shutdown);
process.on("SIGHUP", shutdown);

render();
setTimeout(syncAll, 0);
setInterval(syncAll, POLL_MS);
