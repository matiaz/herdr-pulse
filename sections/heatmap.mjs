import { addDays, eachDay, isoDay } from "../lib/store.mjs";
import { color, MARGIN, PAD, RESET, THEME } from "../lib/term.mjs";
import { createClaudeSource } from "../sources/claude.mjs";
import { createGithubSource } from "../sources/github.mjs";

const PALETTE = [THEME.empty, "#26334f", "#3b598d", "#5b88d6", "#a6c1f2"];
const CELL = "\u{1FB39}\u{1FB13}";
const PITCH = 2;
const LABEL_WIDTH = 5;
const GRID_ROW = 2;
const DAY_LABELS = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"];
const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const MONTH_STEP_WEEKS = 4;

function startOfToday() {
  const now = new Date();
  return new Date(now.getFullYear(), now.getMonth(), now.getDate());
}

function mondayOf(date) {
  return addDays(date, -((date.getDay() + 6) % 7));
}

function monthHeader(start, weeks) {
  const marks = [];
  for (let w = 0; w < weeks; w++) {
    for (let d = 0; d < 7; d++) {
      const day = addDays(start, 7 * w + d);
      if (day.getDate() === 1) marks.push({ w, month: day.getMonth() });
    }
  }
  if (!marks.length || marks[0].w >= 2) marks.unshift({ w: 0, month: start.getMonth() });
  const cells = Array(weeks * PITCH).fill(" ");
  let lastEnd = -2;
  for (const { w, month } of marks) {
    const at = w * PITCH;
    if (at <= lastEnd + 1 || at + 3 > cells.length) continue;
    [...MONTHS[month]].forEach((ch, i) => (cells[at + i] = ch));
    lastEnd = at + 2;
  }
  return cells.join("").trimEnd();
}

export function createHeatmapSection({ view, save, onChange }) {
  const sources = { github: createGithubSource(), claude: createClaudeSource() };
  const order = Object.keys(sources);
  if (!sources[view.source]) view.source = order[0];
  let pointer = null;
  let toggleHit = null;
  let columns = (process.stdout.columns || 43) - 3;

  const source = () => sources[view.source];

  function visibleRange() {
    const weeks = Math.max(4, Math.floor((columns - MARGIN * 2 - LABEL_WIDTH) / PITCH));
    const today = startOfToday();
    const lastMonday = mondayOf(addDays(today, -7 * view.offset));
    const lastSunday = addDays(lastMonday, 6);
    return { weeks, today, start: addDays(lastMonday, -7 * (weeks - 1)), end: lastSunday > today ? today : lastSunday };
  }

  function sync(force = false) {
    const { start, end } = visibleRange();
    source().sync(start, end, onChange, { force });
  }

  function change(fn) {
    fn();
    view.offset = Math.max(0, view.offset);
    save();
    onChange();
    sync();
  }

  function switchSource() {
    change(() => (view.source = order[(order.indexOf(view.source) + 1) % order.length]));
  }

  function hoverLine(start, end, weeks) {
    if (!pointer) return "";
    const weekday = pointer.row - GRID_ROW;
    const week = Math.floor((pointer.x - MARGIN - LABEL_WIDTH - 1) / PITCH);
    const day = addDays(start, 7 * week + weekday);
    if (weekday < 0 || weekday > 6 || week < 0 || week >= weeks || day > end) return "";
    const label = `${WEEKDAYS[day.getDay()]} ${MONTHS[day.getMonth()]} ${day.getDate()}`;
    return `${PAD}${color(THEME.text)}${source().formatTotal(source().value(isoDay(day)))}${color(THEME.muted)} · ${label}${RESET}`;
  }

  return {
    id: "heatmap",
    flex: false,
    title: () => source().title(),
    status: () => source().status(),
    hint: () => `${view.offset ? `-${view.offset}w · ` : ""}←→ scroll  t switch`,

    render(width) {
      columns = width;
      const { weeks, today, start, end } = visibleRange();
      const todayKey = isoDay(today);
      let total = 0;
      eachDay(start, end, (day) => (total += source().value(day)));

      const lines = [hoverLine(start, end, weeks)];
      lines.push(`${PAD}${" ".repeat(LABEL_WIDTH)}${color(THEME.muted)}${monthHeader(start, weeks)}${RESET}`);
      DAY_LABELS.forEach((label, weekday) => {
        let row = `${PAD}${color(THEME.muted)}${label.padStart(3)}${" ".repeat(LABEL_WIDTH - 3)}`;
        for (let w = 0; w < weeks; w++) {
          const day = addDays(start, 7 * w + weekday);
          const key = isoDay(day);
          if (day > end) row += "  ";
          else if (key === todayKey) row += `${color(THEME.green)}${CELL}`;
          else row += `${color(PALETTE[source().level(key)])}${CELL}`;
        }
        lines.push(`${row}${RESET}`);
      });

      lines.push("");
      lines.push(`${PAD}${color(THEME.text)}${source().formatTotal(total)}${RESET}`);
      const legend = PALETTE.map((hex) => `${color(hex)}${CELL}`).join("");
      const legendWidth = MARGIN + 9 + PALETTE.length * PITCH;
      const toggleColumn = Math.max(legendWidth + 2, columns - MARGIN - 1);
      lines.push(`${PAD}${color(THEME.muted)}no usage ${legend}${" ".repeat(toggleColumn - legendWidth)}${color(THEME.muted)}⇄${RESET}`);
      toggleHit = { row: lines.length - 1, x: toggleColumn + 1 };
      return lines;
    },

    hover(point) {
      pointer = point;
    },

    click(x, row) {
      if (toggleHit && row === toggleHit.row && Math.abs(x - toggleHit.x) <= 1) switchSource();
    },

    wheel(direction) {
      change(() => (view.offset += direction < 0 ? 1 : -1));
    },

    key(token) {
      if (token === "\x1b[D" || token === "\x1bOD" || token === "h") change(() => (view.offset += 1));
      else if (token === "\x1b[C" || token === "\x1bOC" || token === "l") change(() => (view.offset -= 1));
      else if (token === "[") change(() => (view.offset += MONTH_STEP_WEEKS));
      else if (token === "]") change(() => (view.offset -= MONTH_STEP_WEEKS));
      else if (token === "0" || token === "g") change(() => (view.offset = 0));
      else if (token === "t" || token === "\t") switchSource();
    },

    sync,
  };
}
