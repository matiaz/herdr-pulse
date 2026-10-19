import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { STATE_DIR } from "../lib/store.mjs";
import { clean } from "../lib/term.mjs";

const HERDR = process.env.HERDR_BIN_PATH || "herdr";
const REVIEW_DIR = path.join(STATE_DIR, "reviews");
const ALLOWED_TOOLS = ["Bash(gh pr review:*)", "Bash(gh api:*)"];

function herdr(args) {
  return new Promise((resolve, reject) => {
    execFile(HERDR, args, { timeout: 15 * 1000 }, (error, stdout, stderr) => {
      if (error) return reject(new Error(clean((stderr || error.message).trim())));
      try {
        resolve(JSON.parse(stdout).result);
      } catch {
        resolve(null);
      }
    });
  });
}

const quote = (text) => `'${text.replaceAll("'", "'\\''")}'`;

function prompt({ url, repo, number, mine }) {
  const outcome = mine
    ? "This is your own pull request, so GitHub does not let you approve it or request changes on it: use the COMMENT event for the review, and if nothing needs to change, post Looks good to me with gh pr comment."
    : `Use the REQUEST_CHANGES event for the review, and if nothing needs to change, approve it with gh pr review ${url} --approve --body "Looks good to me".`;
  return [
    `/code-review:code-review ${url}`,
    "When the review is done, publish the result with the gh account that is already logged in, instead of the final gh pr comment step.",
    `If any issue scored 80 or more, create one pull request review through gh api repos/${repo}/pulls/${number}/reviews with commit_id set to the head commit, a short body that asks for the changes to be addressed, and one inline comment per issue on the file and line it is about.`,
    "If no issue scored 80 or more, or the review stopped because the change is simple and obviously correct, treat it as nothing to change.",
    outcome,
    "If the review stopped because the pull request is closed, is a draft, or you already reviewed it, post nothing.",
    "Do not add any Claude, AI or generated-by attribution.",
  ].join(" ");
}

export async function startReview(item) {
  fs.mkdirSync(REVIEW_DIR, { recursive: true, mode: 0o700 });
  const created = await herdr(["workspace", "create", "--cwd", REVIEW_DIR, "--label", `review ${item.id}`, "--focus"]);
  const pane = created?.root_pane?.pane_id;
  if (!pane) throw new Error("herdr did not return a pane");
  const script = path.join(REVIEW_DIR, `${item.repo.replaceAll("/", "-")}-${item.number}.sh`);
  const command = ["claude", prompt(item), "--allowedTools", ...ALLOWED_TOOLS].map(quote).join(" ");
  fs.writeFileSync(script, `${command}\n`, { mode: 0o600 });
  await herdr(["pane", "run", pane, `sh ${quote(script)}`]);
}
