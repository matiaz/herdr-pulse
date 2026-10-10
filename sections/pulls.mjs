import { spawn } from "node:child_process";
import { BOLD, color, fit, MARGIN, PAD, RESET, THEME } from "../lib/term.mjs";
import { createPullsSource } from "../sources/pulls.mjs";

const ROWS_PER_ITEM = 2;
const DOUBLE_CLICK_MS = 400;
const FLASH_MS = 2000;
const LABELS = {
  merge: ["merge", THEME.green],
  failing: ["ci failed", THEME.red],
  conflict: ["conflict", THEME.red],
  changes: ["changes", THEME.orange],
  behind: ["update", THEME.orange],
  review: ["review", THEME.yellow],
  running: ["ci running", THEME.blue],
  waiting: ["waiting", THEME.muted],
  draft: ["draft", THEME.muted],
};

const CLIPBOARDS = process.platform === "darwin"
  ? [["pbcopy", []]]
  : [["wl-copy", []], ["xclip", ["-selection", "clipboard"]], ["xsel", ["--clipboard", "--input"]]];

function pipeTo(command, args, input) {
  return new Promise((resolve) => {
    const child = spawn(command, args, { stdio: ["pipe", "ignore", "ignore"] });
    child.on("error", () => resolve(false));
    child.on("close", (code) => resolve(code === 0));
    child.stdin.on("error", () => {});
    child.stdin.end(input);
  });
}

async function copy(text) {
  for (const [command, args] of CLIPBOARDS) if (await pipeTo(command, args, text)) return true;
  return false;
}

function open(url) {
  const child = spawn(process.platform === "darwin" ? "open" : "xdg-open", [url], { stdio: "ignore", detached: true });
  child.on("error", () => {});
  child.unref();
}

export function createPullsSection({ onChange }) {
  const source = createPullsSource();
  let scroll = 0;
  let hovered = null;
  let rowItems = [];
  let lastClick = null;
  let flash = null;
  let flashTimer = null;

  function notify(message) {
    flash = message;
    clearTimeout(flashTimer);
    flashTimer = setTimeout(() => {
      flash = null;
      onChange();
    }, FLASH_MS);
    onChange();
  }

  return {
    id: "pulls",
    flex: true,
    title: () => `pull requests${source.items() ? ` · ${source.items().length}` : ""}`,
    status: () => flash ?? source.status(),
    desiredRows: () => (source.items()?.length ? source.items().length * ROWS_PER_ITEM + 1 : 2),

    render(columns, maxRows) {
      const items = source.items();
      rowItems = [];
      if (!items) return ["", `${PAD}${color(THEME.muted)}loading…${RESET}`];
      if (!items.length) return ["", `${PAD}${color(THEME.muted)}nothing waiting on you${RESET}`];

      const inner = columns - MARGIN * 2;
      const room = maxRows - 1;
      const fitsAll = items.length * ROWS_PER_ITEM <= room;
      const capacity = Math.max(1, Math.floor((fitsAll ? room : room - 1) / ROWS_PER_ITEM));
      scroll = Math.min(Math.max(0, scroll), Math.max(0, items.length - capacity));
      const lines = [""];
      rowItems.push(null);
      items.slice(scroll, scroll + capacity).forEach((item, i) => {
        const index = scroll + i;
        const [label, hex] = LABELS[item.action];
        const active = hovered === index;
        const id = fit(item.id, inner - label.length - 2);
        const gap = " ".repeat(Math.max(1, inner - id.length - label.length));
        lines.push(`${PAD}${active ? BOLD : ""}${color(THEME.text)}${id}${RESET}${gap}${color(hex)}${label}${RESET}`);
        lines.push(`${PAD}${color(active ? THEME.text : THEME.muted)}${fit(item.title, inner)}${RESET}`);
        rowItems.push(index, index);
      });
      if (!fitsAll) {
        const below = items.length - scroll - capacity;
        const parts = [scroll ? `↑ ${scroll} above` : "", below ? `↓ ${below} more` : ""].filter(Boolean);
        lines.push(`${PAD}${color(THEME.muted)}${parts.join("  ")}${RESET}`);
      }
      return lines;
    },

    hover(point) {
      hovered = point ? rowItems[point.row] ?? null : null;
    },

    click(x, row) {
      const item = source.items()?.[rowItems[row]];
      if (!item) return;
      const now = Date.now();
      if (lastClick?.url === item.url && now - lastClick.at < DOUBLE_CLICK_MS) {
        lastClick = null;
        open(item.url);
        notify(`opened ${item.id}`);
      } else {
        lastClick = { url: item.url, at: now };
        copy(item.url).then((copied) => notify(copied ? `copied ${item.id}` : "copy failed: no clipboard tool"));
      }
    },

    wheel(direction) {
      scroll += direction;
      onChange();
    },

    key() {},

    sync(force = false) {
      source.sync(onChange, { force });
    },
  };
}
