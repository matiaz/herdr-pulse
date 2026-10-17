import { openUrl } from "../lib/open.mjs";
import { background, color, fit, fitStart, MARGIN, PAD, RESET, THEME, width, wrap } from "../lib/term.mjs";
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
const ACTIVITY = {
  stage: "staging",
  message: "generating message",
  commit: "committing",
  pull: "pulling",
  push: "pushing",
  pr: "writing pull request",
};
const LOCAL_BUTTONS = [["stage", "stage all", "stage"], ["message", "message", "msg"], ["commit", "commit"]];
const CHECKS = {
  SUCCESS: ["✓ checks passed", THEME.green],
  FAILURE: ["✗ checks failed", THEME.red],
  ERROR: ["✗ checks failed", THEME.red],
  PENDING: ["● checks running", THEME.yellow],
  EXPECTED: ["● checks running", THEME.yellow],
};

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
  let remoteRow = -1;
  let navs = [];
  let rows = [];

  const files = () => source.files();
  const enabled = {
    stage: () => files().some(isUnstaged),
    message: () => files().length > 0,
    commit: () => files().some(isStaged),
    pull: () => source.repo()?.behind > 0,
    push: () => {
      const repo = source.repo();
      return Boolean(repo?.current) && (!repo.upstream || repo.ahead > 0);
    },
    pr: () => {
      const repo = source.repo();
      const info = source.remote();
      if (!repo?.current || !info?.defaultBranch || repo.current === info.defaultBranch) return false;
      return Boolean(info.pr) || (repo.upstream && repo.ahead === 0);
    },
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
    pull: () =>
      run("pull", async (repo) => {
        const count = repo.behind;
        await source.pull(repo);
        notify(`pulled ${count} commit${count === 1 ? "" : "s"}`, THEME.green);
      }),
    push: () =>
      run("push", async (repo) => {
        await source.push(repo);
        notify(`pushed ${repo.branch} to ${repo.remote}`, THEME.green);
      }),
    pr: () => {
      const existing = source.remote()?.pr;
      if (existing) {
        if (busy) return;
        openUrl(existing.url);
        notify(`opened PR #${existing.number}`, THEME.green);
        return onChange();
      }
      return run("pr", async (repo) => {
        const { number } = await source.createPullRequest(repo, source.remote().defaultBranch);
        notify(number ? `created PR #${number}` : "created pull request", THEME.green);
      });
    },
  };

  function remoteButtons() {
    const pr = source.remote()?.pr;
    return [["pull", "pull"], ["push", "push"], ["pr", ...(pr ? [`pr #${pr.number}`, `#${pr.number}`] : ["create pr", "pr"])]];
  }

  function remoteLine() {
    const repo = source.repo();
    const info = source.remote();
    if (!repo || !info) return null;
    const parts = [];
    if (info.pr) parts.push(`${color(THEME.text)}${info.pr.draft ? "draft " : ""}PR #${info.pr.number}`);
    else if (repo.current && info.defaultBranch && repo.current !== info.defaultBranch) parts.push(`${color(THEME.muted)}no PR yet`);
    const check = CHECKS[info.checks];
    if (check) parts.push(`${color(check[1])}${check[0]}`);
    return parts.length ? `${PAD}${parts.join(`${color(THEME.muted)} · `)}${RESET}` : null;
  }

  function remoteTarget() {
    const repo = source.repo();
    const info = source.remote();
    if (info?.pr) return info.pr.url;
    if (info?.checks && repo?.slug) return `https://github.com/${repo.slug}/commit/${repo.head}`;
    return null;
  }

  function chip(id, label) {
    const active = enabled[id]() && !busy;
    const hovered = active && buttons.find((b) => b.id === id && pointer?.row === b.row && pointer.x >= b.from && pointer.x <= b.to);
    const fill = busy === id ? THEME.blue : !active ? CHIP_OFF : hovered ? CHIP_HOVER : CHIP;
    const ink = busy === id ? "#0d1117" : active ? THEME.text : THEME.muted;
    return `${background(fill)}${color(ink)} ${label} ${RESET}`;
  }

  function buttonRow(variants, inner, row, placed) {
    const widthOf = (labels, gap) => labels.reduce((sum, [, label]) => sum + label.length + 2, 0) + gap * (labels.length - 1);
    const levels = Math.max(...variants.map((variant) => variant.length - 1));
    let labels = [];
    let gap = 1;
    for (let level = 0; level < levels; level++) {
      labels = variants.map(([id, ...names]) => [id, names[Math.min(level, names.length - 1)]]);
      gap = [BUTTON_GAP, 1].find((g) => widthOf(labels, g) <= inner);
      if (gap) break;
      gap = 1;
    }
    const indent = MARGIN + Math.max(0, Math.floor((inner - widthOf(labels, gap)) / 2));
    let x = indent + 1;
    for (const [id, label] of labels) {
      placed.push({ id, row, from: x, to: x + label.length + 1 });
      x += label.length + 2 + gap;
    }
    return `${" ".repeat(indent)}${labels.map(([id, label]) => chip(id, label)).join(" ".repeat(gap))}`;
  }

  function actionLines(inner, offset = 0) {
    const lines = [""];
    const status = remoteLine();
    remoteRow = status ? offset + lines.length : -1;
    if (status) lines.push(status);
    const placed = [];
    lines.push(buttonRow(LOCAL_BUTTONS, inner, offset + lines.length, placed));
    lines.push(buttonRow(remoteButtons(), inner, offset + lines.length, placed));
    buttons = placed;
    if (busy) lines.push(`${PAD}${color(THEME.blue)}${SPINNER[frame % SPINNER.length]} ${color(THEME.muted)}${ACTIVITY[busy]}…${RESET}`);
    else if (notice) lines.push(`${PAD}${color(notice.hex)}${wrap(notice.text, inner, 1)[0]}${RESET}`);
    if (message) for (const line of wrap(message, inner, PREVIEW_LINES)) lines.push(`${PAD}${color(THEME.text)}${line}${RESET}`);
    return lines;
  }

  function hovering(from, to, row) {
    return pointer?.row === row && pointer.x >= from && pointer.x <= to;
  }

  function navChip(id, label, from, active) {
    navs.push({ id, from, to: from + label.length + 1, active });
    const fill = !active ? CHIP_OFF : hovering(from, from + label.length + 1, 0) ? CHIP_HOVER : CHIP;
    return `${background(fill)}${color(active ? THEME.text : THEME.muted)} ${label} ${RESET}`;
  }

  function navLine(inner) {
    navs = [];
    const workspace = source.workspace();
    const repo = source.repo();
    if (!workspace || !repo) return "";
    const index = workspace.repos.findIndex((r) => r.top === repo.top);
    const many = workspace.repos.length > 1;
    const count = `${index + 1}/${workspace.repos.length}`;
    const left = `${navChip("prev", "‹", MARGIN + 1, many)} ${color(THEME.muted)}${count}${RESET} ${navChip("next", "›", MARGIN + 6 + count.length, many)}`;
    const label = ["all repos", "all"].find((name) => inner - name.length - 2 - (count.length + 8) > 0);
    if (!label) return `${PAD}${left}`;
    const from = MARGIN + inner - label.length - 1;
    const gap = from - 1 - MARGIN - (count.length + 8);
    return `${PAD}${left}${" ".repeat(gap)}${navChip("all", label, from, true)}`;
  }

  function cycle(step) {
    const workspace = source.workspace();
    const repo = source.repo();
    if (!workspace || !repo || busy) return;
    const list = workspace.repos;
    const index = list.findIndex((r) => r.top === repo.top);
    source.select(list[(index + step + list.length) % list.length].top);
  }

  function repoLines(inner, room) {
    const list = source.workspace().repos;
    const lines = [""];
    const capacity = Math.max(1, room - 1);
    const offset = Math.min(Math.max(0, scroll), Math.max(0, list.length - capacity));
    if (Number.isFinite(room)) scroll = offset;
    rows = [];
    for (const r of list.slice(offset, offset + capacity)) {
      const row = lines.length;
      rows.push({ row, top: r.top });
      const counts = [
        r.changed ? `${color(THEME.yellow)}${r.changed} changed` : `${color(THEME.muted)}clean`,
        r.ahead ? `${color(THEME.green)}↑${r.ahead}` : "",
        r.behind ? `${color(THEME.blue)}↓${r.behind}` : "",
      ].filter(Boolean).join(" ");
      const space = Math.max(0, inner - width(counts) - 1);
      const name = fitStart(r.name, space);
      const branch = fit(r.branch, space - width(name) - 1);
      const gap = Math.max(1, inner - width(name) - (branch ? width(branch) + 1 : 0) - width(counts));
      const left = `${color(THEME.text)}${name}${branch ? ` ${color(THEME.muted)}${branch}` : ""}`;
      const fill = pointer?.row === row ? background(CHIP_HOVER) : "";
      lines.push(`${PAD}${fill}${left}${" ".repeat(gap)}${counts}${RESET}`);
    }
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
    if (!repo) {
      buttons = [];
      navs = [];
      remoteRow = -1;
      return repoLines(inner, maxRows);
    }
    rows = [];
    if (messageFor && messageFor !== repo.top) message = messageFor = null;
    const actionRows = actionLines(inner).length;
    const top = [navLine(inner), ...listLines(inner, maxRows - 1 - actionRows)];
    const padding = Number.isFinite(maxRows) ? Math.max(0, maxRows - top.length - actionRows) : 0;
    return [...top, ...Array(padding).fill(""), ...actionLines(inner, top.length + padding)];
  }

  setInterval(() => source.refresh(), POLL_MS);

  return {
    id: "git",
    flex: true,
    visible: () => Boolean(source.repo() || source.workspace()),
    title: () => {
      const repo = source.repo();
      return repo ? `git · ${repo.name} · ${repo.branch}` : `git · ${source.workspace()?.name}`;
    },
    status: () => {
      const repo = source.repo();
      if (!repo) return `${source.workspace()?.repos.length} repos`;
      const counts = [repo?.ahead ? `↑${repo.ahead}` : "", repo?.behind ? `↓${repo.behind}` : ""].filter(Boolean);
      return counts.length ? counts.join(" ") : null;
    },
    desiredRows: (columns) => body(columns, Infinity).length,
    render: body,

    hover(point) {
      pointer = point;
      if (point) source.hold();
    },

    click(x, row) {
      source.hold();
      const repoRow = rows.find((r) => r.row === row);
      if (repoRow) {
        scroll = 0;
        return source.select(repoRow.top);
      }
      const nav = row === 0 && navs.find((n) => n.active && x >= n.from && x <= n.to);
      if (nav) {
        if (busy) return;
        if (nav.id === "all") {
          scroll = 0;
          return source.showAll();
        }
        return cycle(nav.id === "prev" ? -1 : 1);
      }
      if (row === remoteRow) {
        const url = remoteTarget();
        if (url) openUrl(url);
        return;
      }
      const hit = buttons.find((button) => button.row === row && x >= button.from && x <= button.to);
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
