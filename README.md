# Pulse

A side dock for [Herdr](https://herdr.dev) that keeps three things in view while you work:

- **Activity heatmap.** Your GitHub contributions or your Claude Code usage, drawn as a contribution calendar.
- **Pull requests.** Every open PR you authored, are assigned to, or have been asked to review, with what it needs from you next.
- **Git.** The changes in the folder you are working in, with buttons to stage everything, write a commit message with Claude, commit, and push.

Each panel sits in its own box. You can reorder the boxes, and Pulse remembers the order and the dock width.

## No configuration needed

Pulse uses the tools and accounts you are already logged into:

| Panel | Where its data comes from |
| --- | --- |
| Activity heatmap, GitHub view | The GitHub account the GitHub CLI is logged into. Check it with `gh auth status`. If you switch accounts with `gh auth switch`, Pulse follows. |
| Activity heatmap, Claude Code view | The Claude Code session transcripts on this computer, in `~/.claude/projects`. |
| Claude plan usage | Your existing Claude Code login. |
| Pull requests | The same `gh` account as the heatmap. |
| Git | The folder of the pane you are focused on in the same tab. Commits use the name and email your git is configured with for that repository. |
| Commit messages | Your existing Claude Code login. |

There is nothing to set up inside Pulse: no tokens, usernames or paths.

## Requirements

| Tool | Needed for | Notes |
| --- | --- | --- |
| Herdr 0.9.3 or newer | everything | |
| Node.js 20 or newer | everything | Pulse has no npm dependencies and no build step. |
| [GitHub CLI](https://cli.github.com) (`gh`) | heatmap, pull requests | Log in once with `gh auth login`. |
| `git` | git panel | |
| [Claude Code](https://claude.com/claude-code) (`claude`) | commit messages | Optional. Only the **message** button needs it. |
| `pbcopy` (macOS), or `wl-copy`, `xclip` or `xsel` (Linux) | copying PR links | |

Pulse runs on macOS and Linux.

## Install

```sh
herdr plugin install matiaz/herdr-pulse
```

Herdr shows the manifest before installing. Pulse runs no build commands.

To update, run the same command again. Herdr replaces its copy of the plugin.

## Showing and hiding the dock

**When Herdr starts,** Pulse opens on the right edge of the tab you are looking at. Your focus stays in the pane you were using.

**To show or hide it** at any time, bind the plugin's toggle action to a key. Add this to `~/.config/herdr/config.toml`:

```toml
[[keys.command]]
key = "prefix+a"
type = "plugin_action"
command = "matiaz.pulse.toggle"
description = "toggle pulse"
```

Now press your Herdr prefix (`ctrl+b` by default), then `a`. The same keys open the dock when it is hidden and close it when it is showing. Use any free key instead of `a` if you prefer.

**To use a command instead,** add an alias to your shell config (`~/.zshrc` or `~/.bashrc`):

```sh
alias pulse='herdr plugin action invoke toggle --plugin matiaz.pulse'
```

Open a new shell, then type `pulse` in any pane inside Herdr to show or hide the dock.

The dock belongs to one tab. Toggling it in another tab opens a separate dock there. Closing it loses nothing: it comes back with the same box order and width.

## Panels

### Activity heatmap

Weeks run left to right and weekdays top to bottom. Today is green and days with no activity are dim squares. Hover over a day to see its exact value. The total under the calendar covers the weeks on screen.

Click **t switch**, or press `t`, to change between the two views:

- **GitHub** shows the contribution counts from your GitHub profile calendar.
- **Claude Code** shows the estimated cost per day of your Claude Code usage, priced at public API rates. It is an estimate of what the usage would cost on the API, not a bill, and it only covers this computer.

The Claude Code view also shows how much of your plan you have used, under the legend:

```
session ━━━━━━━━   8%  resets in 2h 38m
weekly  ━━━━━━━━  13%  resets Wed 12:00
```

- **session** is the current 5-hour usage window and when it resets.
- **weekly** is the 7-day limit and when it resets, in your local time.

These are the same numbers Claude Code's `/usage` shows. They refresh every 2 minutes while the Claude Code view is showing; press `r` to refresh now. The bar turns yellow at 70% and red at 90%. This needs a Claude Pro or Max login in Claude Code. With an API key login there is no plan to measure, so Pulse shows a short note instead.

Claude Code deletes transcripts older than 30 days by default. Pulse keeps its own daily totals from the first time it runs, so the calendar keeps your history after the transcripts are gone.

### Pull requests

This box lists every open pull request on GitHub where you are the author, an assignee, or a requested reviewer, across all your repositories and organizations. Each one shows its repository and number, such as `owner/repo#123`, and its title. To open it from a terminal, run `gh pr view 123 --repo owner/repo`.

The label on the right says what the PR needs next. The most urgent ones come first:

| Label | Meaning |
| --- | --- |
| `merge` | Checks pass and it is ready to merge. |
| `ci failed` | A check failed. |
| `conflict` | It has merge conflicts with its base branch. |
| `changes` | A reviewer requested changes. |
| `update` | The branch is behind its base. |
| `review` | Someone asked for your review. |
| `ci running` | Checks are still running. |
| `waiting` | Waiting on reviewers. |
| `draft` | Still a draft. |

- **Click** a pull request to copy its URL. The box title briefly confirms it.
- **Double-click** it to open it in your browser.

The list refreshes every 2 minutes. Press `r` to refresh now.

### Git

This box follows the pane you are focused on in the same tab. When that pane's folder is inside a git repository with a GitHub remote, the box shows the repository name, the branch, and every changed file. Otherwise the box hides itself.

Each file shows what happened to it:

| Label | Color | Meaning |
| --- | --- | --- |
| `modified` | yellow | Changed. |
| `added` | green | New and staged. |
| `new` | green | New and not tracked by git yet. |
| `deleted` | red | Removed. |
| `renamed` | blue | Moved or renamed. |
| `conflict` | red | Has unresolved merge conflicts. |

The mark before it says whether it is staged: `●` staged, `◐` partly staged, `○` not staged.

The four buttons sit at the bottom of the box:

1. **stage all** stages every change, including new and deleted files (`git add -A`).
2. **message** asks Claude to describe your changes in one or two sentences. Claude reads the staged changes, or every change if nothing is staged yet. The message appears under the buttons as `branch-name: message`, so you can read it before committing.
3. **commit** commits the staged files with that message. If you did not generate one, it uses just the branch name as the message. The button stays disabled until something is staged.
4. **push** pushes the branch to its GitHub remote. The first push of a new branch sets its upstream (`git push --set-upstream origin branch-name`); after that it is a plain `git push`. The button stays disabled until there is something to push, and the box title shows how many commits are waiting, such as `↑2`. Pulse never force-pushes: if the remote has commits you don't have, the push is rejected and Pulse tells you to pull first.

After a commit, the message preview and the list clear and the box shows the new commit's short hash.

While stage, message, commit or push is running, a small hexagon animation shows what is happening and every button is disabled. A double tap cannot create two commits or two pushes.

Push uses the credentials your git already has, such as an SSH key in your agent or a credential helper. Pulse cannot answer a password or passphrase prompt, so if git needs one, the push fails with a message instead of waiting. Push once from a terminal to unlock it, then the button works.

On a narrow dock, **stage all** is shortened to **stage** so all four buttons fit.

### Arranging the boxes

Click `↑` or `↓` in a box's title to move it, or drag a title onto another box. Pulse remembers the order, and the dock width if you resize it, for next time.

## Privacy and data

Pulse keeps everything on your computer and has no server of its own.

- **What it stores.** Caches and preferences go in Herdr's plugin state directory, `~/.local/state/herdr/plugins/matiaz.pulse/`. That is your contribution counts, your daily Claude Code cost totals, your last plan usage percentages, your open pull request list, the box order and the dock width. Only your user account can read it. Nothing is written to the plugin's own folder.
- **What it sends to GitHub.** Read-only queries through your `gh` login, for your contribution calendar and your open pull requests. When you press **push**, git pushes your branch the same way it does from a terminal.
- **What it sends to Anthropic.** While the Claude Code view is showing, a read-only request for your plan usage every 2 minutes. It reads Claude Code's login token from the macOS keychain, or from `~/.claude/.credentials.json` on Linux, and only sends it to `api.anthropic.com`. Pulse never refreshes or stores the token: if it has expired, open Claude Code once and Pulse picks up the new one. Nothing else goes to Anthropic unless you press **message**. Then the staged diff (or the unstaged diff if nothing is staged), cut to 24 KB, and the list of changed file names go to Claude through your Claude Code login. Files that commonly hold secrets or noise are left out of the diff: `.env*`, `*.pem`, `*.key`, `*.p12`, SSH keys, anything with `secret` in its name, and lockfiles. Their names can still appear in the file list. The request runs without tools, hooks, MCP servers or session history.
- **What it runs.** `gh`, `git`, `claude`, `herdr`, and your clipboard and browser openers. It runs them directly, never through a shell. Git runs with `core.fsmonitor` turned off, without external diff or textconv drivers and without taking the index lock, so watching a repository never runs that repository's configured programs or blocks your own git commands.
- **What it shows.** Pull request titles, branch names and file names can come from other people, so Pulse strips terminal control characters from them before drawing.

To remove all local data, delete the state directory above.

## How it is built

```
herdr-plugin.toml   manifest: the dock pane, the toggle action, the startup hook
bin/run.sh          puts common install locations on PATH, then runs node
app.mjs             the dock: layout, boxes, mouse and keyboard
dock.mjs            opens, closes and sizes the dock pane through the herdr CLI
sections/           one file per box: what it draws and how it reacts to input
sources/            data for each box: GitHub, Claude Code transcripts, pull requests, git
lib/                state files and terminal drawing helpers
```

To work on it locally:

```sh
git clone https://github.com/matiaz/herdr-pulse
herdr plugin link ./herdr-pulse
```

Linked plugins run straight from your clone, so close and reopen the dock to pick up changes.

## License

[MIT](LICENSE)
