import { background, color, fitStart, MARGIN, PAD, RESET, THEME, wrap } from "../lib/term.mjs";
import { createGitSource, isStaged, isUnstaged, kindOf } from "../sources/git.mjs";

const POLL_MS = 2000;
const SPIN_MS = 140;
const NOTICE_MS = 4000;
const PREVIEW_LINES = 3;
const BUTTON_GAP = 2;
const SPINNER = ["⬢⬡⬡", "⬡⬢⬡", "⬡⬡⬢", "⬡⬢⬡"];
const CHIP = "#373e47";
const CHIP_HOVER = "#444c56";
const CHIP_OFF = "#22272e";
const KINDS = {
  modified: THEME.yellow,
  added: THEME.green,
  new: THEME.green,
  deleted: THEME.red,
  renamed: THEME.blue,
  copied: THEME.blue,
  conflict: THEME.red,
};
const ACTIVITY = { stage: "staging", message: "generating message", commit: "committing" };

export function createGitSection({ selfMarker, onChange }) {
  const source = createGitSource({ selfMarker, onChange });
  let message = null;
  let messageFor = null;
  let busy = null;
  let frame = 0;
  let spinTimer = null;
  let notice = null;
  let noticeTimer = null;
  let scroll = 0;
  let pointer = null;
  let buttons = [];
  let buttonsRow = -1;

  const files = () => source.files();
  const enabled = {
    stage: () => files().some(isUnstaged),
    message: () => files().length > 0,
    commit: () => files().some(isStaged),
  };

  function notify(text, hex) {
    notice = { text, hex };
    clearTimeout(noticeTimer);
    noticeTimer = setTimeout(() => {
      notice = null;
      onChange();
    }, NOTICE_MS);
  }

  async function run(action, work) {
    const repo = source.repo();
    if (busy || !repo || !enabled[action]()) return;
    busy = action;
    frame = 0;
    spinTimer = setInterval(() => {
      frame++;
      onChange();
    }, SPIN_MS);
    onChange();
    try {
      await work(repo);
    } catch (error) {
      notify(`${action} failed: ${error.message}`, THEME.red);
    } finally {
      clearInterval(spinTimer);
      busy = null;
      await source.refresh();
      onChange();
    }
  }

  const actions = {
    stage: () => run("stage", (repo) => source.stageAll(repo)),
    message: () =>
      run("message", async (repo) => {
        message = await source.generateMessage(repo);
        messageFor = repo.top;
      }),
    commit: () =>
      run("commit", async (repo) => {
        const sha = await source.commit(repo, messageFor === repo.top && message ? message : repo.branch);
        message = null;
        notify(`committed ${sha}`, THEME.green);
      }),
  };

  function chip(id, label) {
    const active = enabled[id]() && !busy;
    const hovered = active && pointer?.row === buttonsRow && buttons.find((b) => b.id === id && pointer.x >= b.from && pointer.x <= b.to);
    const fill = busy === id ? THEME.blue : !active ? CHIP_OFF : hovered ? CHIP_HOVER : CHIP;
    const ink = busy === id ? "#0d1117" : active ? THEME.text : THEME.muted;
    return `${background(fill)}${color(ink)} ${label} ${RESET}`;
  }

  function actionLines(inner) {
    const labels = [["stage", "stage all"], ["message", "message"], ["commit", "commit"]];
    const total = labels.reduce((sum, [, label]) => sum + label.length + 2, 0) + BUTTON_GAP * (labels.length - 1);
    const indent = MARGIN + Math.max(0, Math.floor((inner - total) / 2));
    buttons = [];
    let x = indent + 1;
    for (const [id, label] of labels) {
      buttons.push({ id, from: x, to: x + label.length + 1 });
      x += label.length + 2 + BUTTON_GAP;
    }
    const lines = ["", `${" ".repeat(indent)}${labels.map(([id, label]) => chip(id, label)).join(" ".repeat(BUTTON_GAP))}`];
    if (busy) lines.push(`${PAD}${color(THEME.blue)}${SPINNER[frame % SPINNER.length]} ${color(THEME.muted)}${ACTIVITY[busy]}…${RESET}`);
    else if (notice) lines.push(`${PAD}${color(notice.hex)}${wrap(notice.text, inner, 1)[0]}${RESET}`);
    if (message) for (const line of wrap(message, inner, PREVIEW_LINES)) lines.push(`${PAD}${color(THEME.text)}${line}${RESET}`);
    return lines;
  }

  function listLines(inner, room) {
    const list = files();
    if (!list.length) return [`${PAD}${color(THEME.muted)}working tree clean${RESET}`];
    const staged = list.filter(isStaged).length;
    const summary = `${list.length} changed · ${staged} staged`;
    const legend = "● staged  ○ unstaged";
    const gap = inner - summary.length - legend.length;
    const lines = [`${PAD}${color(THEME.muted)}${summary}${gap >= 3 ? `${" ".repeat(gap)}${legend}` : ""}${RESET}`];

    const fitsAll = list.length <= room - 1;
    const capacity = Math.max(1, fitsAll ? room - 1 : room - 2);
    const offset = Math.min(Math.max(0, scroll), Math.max(0, list.length - capacity));
    if (Number.isFinite(room)) scroll = offset;
    for (const file of list.slice(offset, offset + capacity)) {
      const kind = kindOf(file);
      const marker = isStaged(file) ? (isUnstaged(file) ? `${color(THEME.yellow)}◐` : `${color(THEME.green)}●`) : `${color(THEME.muted)}○`;
      lines.push(`${PAD}${marker} ${color(KINDS[kind])}${kind.padEnd(9)}${color(THEME.text)}${fitStart(file.path, inner - 12)}${RESET}`);
    }
    if (!fitsAll) {
      const below = list.length - offset - capacity;
      const parts = [offset ? `↑ ${offset} above` : "", below ? `↓ ${below} more` : ""].filter(Boolean);
      lines.push(`${PAD}${color(THEME.muted)}${parts.join("  ")}${RESET}`);
    }
    return lines;
  }

  function body(columns, maxRows) {
    const repo = source.repo();
    const inner = columns - MARGIN * 2;
    if (messageFor && messageFor !== repo.top) message = messageFor = null;
    const actionRows = actionLines(inner).length;
    const top = ["", ...listLines(inner, maxRows - 1 - actionRows)];
    const padding = Number.isFinite(maxRows) ? Math.max(0, maxRows - top.length - actionRows) : 0;
    buttonsRow = top.length + padding + 1;
    return [...top, ...Array(padding).fill(""), ...actionLines(inner)];
  }

  setInterval(() => source.refresh(), POLL_MS);

  return {
    id: "git",
    flex: true,
    visible: () => Boolean(source.repo()),
    title: () => `git · ${source.repo()?.name} · ${source.repo()?.branch}`,
    status: () => null,
    desiredRows: (columns) => body(columns, Infinity).length,
    render: body,

    hover(point) {
      pointer = point;
    },

    click(x, row) {
      if (row !== buttonsRow) return;
      const hit = buttons.find((button) => x >= button.from && x <= button.to);
      if (hit) actions[hit.id]();
    },

    wheel(direction) {
      scroll += direction;
      onChange();
    },

    key() {},

    sync() {
      source.refresh();
    },
  };
}
