import { spawn } from "node:child_process";
import { notifyTransitions, showNotification } from "../lib/notify.mjs";
import { openUrl } from "../lib/open.mjs";
import { claimLeader, releaseLeader } from "../lib/leader.mjs";
import { createReviewStore } from "../lib/review-store.mjs";
import { setting } from "../lib/settings.mjs";
import { createStatusToken } from "../lib/status-token.mjs";
import { BOLD, clean, color, fit, MARGIN, PAD, RESET, THEME, width } from "../lib/term.mjs";
import { createWorkspaces, scopePulls } from "../lib/workspaces.mjs";
import { autoMerge, createMerge } from "../sources/merge.mjs";
import { createPullsSource, isPullUrl } from "../sources/pulls.mjs";
import { autoReview, startReview } from "../sources/review.mjs";

const DOUBLE_CLICK_MS = 400;
const CONFIRM_MS = 3000;
const FLASH_MS = 2000;
const PANES_EVERY_MS = 10 * 1000;
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
const NOTES = {
  loading: "loading…",
  unavailable: "could not list Herdr panes",
  "no-workspace": "focus a pane to see its pull requests",
  "no-remote": "the focused folder has no GitHub remote",
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

export function createPullsSection({ onChange }) {
  const source = createPullsSource();
  const workspaces = createWorkspaces();
  const store = createReviewStore();
  const merge = createMerge();
  const token = createStatusToken();
  const reviewing = new Set();
  let scroll = 0;
  let hovered = null;
  let rowItems = [];
  let shown = [];
  let lastClick = null;
  let lastOpened = null;
  let armed = null;
  let armTimer = null;
  let flash = null;
  let flashTimer = null;
  let automating = false;

  function notify(message) {
    flash = message;
    clearTimeout(flashTimer);
    flashTimer = setTimeout(() => {
      flash = null;
      onChange();
    }, FLASH_MS);
    onChange();
  }

  const scoped = (items) => scopePulls(items, setting("pulls.scope"), workspaces);
  const noteOf = (item) => clean(store.get(item.url)?.mergeError ?? "");
  const heightOf = (item) => (noteOf(item) ? 3 : 2);

  function arm(item) {
    armed = { url: item.url, at: Date.now() };
    clearTimeout(armTimer);
    armTimer = setTimeout(() => {
      armed = null;
      onChange();
    }, CONFIRM_MS);
    onChange();
  }

  function disarm() {
    armed = null;
    clearTimeout(armTimer);
  }

  async function review(item) {
    if (reviewing.has(item.url)) return;
    reviewing.add(item.url);
    notify(`starting review of ${item.id}`);
    try {
      await workspaces.refresh();
      await startReview(item, {
        ...workspaces.match(item.repo),
        focus: true,
        autoApprove: setting("reviews.autoApprove"),
        loopMinutes: setting("reviews.loopMinutes"),
      });
      store.record(item.url);
      notify(`reviewing ${item.id}`);
    } catch (error) {
      notify(`review failed: ${clean(error.message)}`);
    } finally {
      reviewing.delete(item.url);
    }
  }

  async function afterFetch(notable) {
    if (automating) return;
    automating = true;
    try {
      await workspaces.refresh();
      if (!claimLeader()) return;
      await notifyTransitions(scoped(notable).items);
      const all = source.items() ?? [];
      store.seen(all.map((item) => item.url));
      if (setting("reviews.auto")) {
        const result = await autoReview(all, {
          workspaces,
          store,
          reviewing,
          autoApprove: setting("reviews.autoApprove"),
          loopMinutes: setting("reviews.loopMinutes"),
          alert: showNotification,
        });
        if (result?.failed) notify(`auto review failed: ${result.message}`);
      }
      if (setting("reviews.autoMerge")) {
        try {
          await autoMerge(all, { store, method: setting("reviews.mergeMethod"), merge, alert: showNotification });
        } catch {}
      }
      await token.report(workspaces.workspaceRepos(), scoped(all).items);
    } catch {
    } finally {
      automating = false;
      onChange();
    }
  }

  process.on("exit", releaseLeader);

  const panesTimer = setInterval(() => workspaces.refresh().then(onChange, () => {}), PANES_EVERY_MS);
  panesTimer.unref?.();

  return {
    id: "pulls",
    flex: true,
    title: () => {
      if (armed) return "Run review?";
      const items = source.items();
      return `pull requests${items ? ` · ${scoped(items).items.length}` : ""}`;
    },
    status: () => flash ?? source.status(),
    desiredRows: () => {
      const items = source.items() ? scoped(source.items()).items : [];
      return items.length ? items.reduce((n, item) => n + heightOf(item), 0) + 1 : 2;
    },

    render(columns, maxRows) {
      const all = source.items();
      rowItems = [];
      shown = [];
      if (!all) return ["", `${PAD}${color(THEME.muted)}loading…${RESET}`];
      const { items, reason } = scoped(all);
      if (!items.length) return ["", `${PAD}${color(THEME.muted)}${NOTES[reason] ?? "nothing waiting on you"}${RESET}`];
      shown = items;

      const inner = columns - MARGIN * 2;
      const room = maxRows - 1;
      const total = items.reduce((n, item) => n + heightOf(item), 0);
      const fitsAll = total <= room;
      const budget = Math.max(1, fitsAll ? room : room - 1);
      let maxScroll = items.length - 1;
      for (let i = items.length - 1, used = 0; i >= 0 && used + heightOf(items[i]) <= budget; i--) {
        used += heightOf(items[i]);
        maxScroll = i;
      }
      scroll = Math.min(Math.max(0, scroll), maxScroll);

      const lines = [""];
      rowItems.push(null);
      let used = 0;
      let index = scroll;
      while (index < items.length && (index === scroll || used + heightOf(items[index]) <= budget)) {
        const item = items[index];
        const [label, hex] = LABELS[item.action];
        const active = hovered === index;
        const idRoom = inner - label.length - 2;
        const id = fit(item.id, idRoom);
        const authorRoom = idRoom - width(id) - 1;
        const author = item.author && authorRoom > 2 ? ` ${fit(clean(item.author), authorRoom)}` : "";
        const gap = " ".repeat(Math.max(1, inner - width(id) - width(author) - label.length));
        lines.push(`${PAD}${active ? BOLD : ""}${color(THEME.text)}${id}${RESET}${color(THEME.muted)}${author}${RESET}${gap}${color(hex)}${label}${RESET}`);
        lines.push(`${PAD}${color(active ? THEME.text : THEME.muted)}${fit(item.title, inner)}${RESET}`);
        rowItems.push(index, index);
        const note = noteOf(item);
        if (note) {
          lines.push(`${PAD}${color(THEME.orange)}${fit(note, inner)}${RESET}`);
          rowItems.push(index);
        }
        used += heightOf(item);
        index++;
      }
      if (!fitsAll) {
        const below = items.length - index;
        const parts = [scroll ? `↑ ${scroll} above` : "", below ? `↓ ${below} more` : ""].filter(Boolean);
        lines.push(`${PAD}${color(THEME.muted)}${parts.join("  ")}${RESET}`);
      }
      return lines;
    },

    hover(point) {
      hovered = point ? rowItems[point.row] ?? null : null;
    },

    click(x, row) {
      const item = shown[rowItems[row]];
      if (!item) return;
      lastOpened = item.url;
      const now = Date.now();
      if (lastClick?.url === item.url && now - lastClick.at < DOUBLE_CLICK_MS) {
        lastClick = null;
        if (armed?.url === item.url && now - armed.at < CONFIRM_MS) {
          disarm();
          review(item);
        } else arm(item);
      } else {
        lastClick = { url: item.url, at: now };
        copy(item.url).then((copied) => notify(copied ? "copied url" : "copy failed: no clipboard tool"));
      }
    },

    wheel(direction) {
      scroll += direction;
      onChange();
    },

    key(input) {
      if (input !== "o" || !isPullUrl(lastOpened)) return;
      openUrl(lastOpened);
      notify("opened in browser");
    },

    sync(force = false) {
      source.sync(onChange, { force, onFetched: afterFetch });
      workspaces.refresh().then(onChange, () => {});
    },
  };
}
