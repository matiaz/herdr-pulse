export const MARGIN = 1;
export const PAD = " ".repeat(MARGIN);
export const RESET = "\x1b[0m";
export const BOLD = "\x1b[1m";
export const THEME = {
  text: "#c9d1d9",
  muted: "#7d8590",
  empty: "#2d333b",
  green: "#57ab5a",
  red: "#e5534b",
  orange: "#d4843e",
  yellow: "#c69026",
  blue: "#5b88d6",
};

export function color(hex) {
  return `\x1b[38;2;${parseInt(hex.slice(1, 3), 16)};${parseInt(hex.slice(3, 5), 16)};${parseInt(hex.slice(5, 7), 16)}m`;
}

const WIDE = /[\u1100-\u115F\u231A\u231B\u2329\u232A\u23E9-\u23EC\u23F0\u23F3\u25FD\u25FE\u2614\u2615\u2648-\u2653\u267F\u2693\u26A1\u26AA\u26AB\u26BD\u26BE\u26C4\u26C5\u26CE\u26D4\u26EA\u26F2\u26F3\u26F5\u26FA\u26FD\u2705\u270A\u270B\u2728\u274C\u274E\u2753-\u2755\u2757\u2795-\u2797\u27B0\u27BF\u2B1B\u2B1C\u2B50\u2B55\u2E80-\u303E\u3041-\u33FF\u3400-\u4DBF\u4E00-\u9FFF\uA000-\uA4CF\uA960-\uA97F\uAC00-\uD7A3\uF900-\uFAFF\uFE10-\uFE19\uFE30-\uFE6F\uFF00-\uFF60\uFFE0-\uFFE6\u{1F004}\u{1F0CF}\u{1F18E}\u{1F191}-\u{1F19A}\u{1F200}-\u{1F251}\u{1F300}-\u{1F64F}\u{1F680}-\u{1F6FF}\u{1F7E0}-\u{1F7EB}\u{1F90C}-\u{1F9FF}\u{1FA70}-\u{1FAFF}\u{20000}-\u{3FFFD}]/u;
const ZERO_WIDTH = /[\u0300-\u036F\u200B-\u200F\uFE00-\uFE0F\u{E0100}-\u{E01EF}]/u;

const cellWidth = (char) => (ZERO_WIDTH.test(char) ? 0 : WIDE.test(char) ? 2 : 1);

export function clean(text) {
  return String(text ?? "")
    .replace(/[\t\n\r]+/g, " ")
    .replace(/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g, "");
}

export function width(text) {
  let cells = 0;
  for (const char of text.replace(/\x1b\[[\d;]*m/g, "")) cells += cellWidth(char);
  return cells;
}

function take(chars, max) {
  let cells = 0;
  let count = 0;
  for (const char of chars) {
    if (cells + cellWidth(char) > max) break;
    cells += cellWidth(char);
    count++;
  }
  return count;
}

export function fit(text, max) {
  max = Math.max(0, max);
  if (width(text) <= max) return text;
  const chars = [...text];
  if (max <= 1) return chars.slice(0, take(chars, max)).join("");
  return `${chars.slice(0, take(chars, max - 1)).join("")}…`;
}

export function background(hex) {
  return `\x1b[48;2;${parseInt(hex.slice(1, 3), 16)};${parseInt(hex.slice(3, 5), 16)};${parseInt(hex.slice(5, 7), 16)}m`;
}

export function fitStart(text, max) {
  max = Math.max(0, max);
  if (width(text) <= max) return text;
  const reversed = [...text].reverse();
  return `…${reversed.slice(0, take(reversed, max - 1)).reverse().join("")}`;
}

export function wrap(text, max, limit) {
  const lines = [];
  let line = "";
  for (const word of text.split(/\s+/).filter(Boolean)) {
    if (line && width(line) + 1 + width(word) > max) {
      lines.push(line);
      line = word;
    } else line = line ? `${line} ${word}` : word;
  }
  if (line) lines.push(line);
  if (lines.length > limit) lines.splice(limit - 1, lines.length, fit(lines.slice(limit - 1).join(" "), max));
  return lines.map((l) => fit(l, max));
}
