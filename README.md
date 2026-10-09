# Pulse

A side dock for [Herdr](https://herdr.dev) that keeps three things in view while you work:

- **Activity heatmap.** Your GitHub contributions or your Claude Code usage, drawn as a contribution calendar.
- **Pull requests.** Every open PR you authored, are assigned to, or have been asked to review, with what it needs from you next.
- **Git.** The working tree of the folder you are in, with one-tap staging, an AI-written commit message and commit.

Each panel sits in its own box. You can reorder the boxes, and Pulse remembers the order and the dock width.

## Requirements

| Tool | Needed for | Notes |
| --- | --- | --- |
| Herdr 0.9.3 or newer | everything | |
| Node.js 20 or newer | everything | Pulse has no npm dependencies and no build step. |
| [GitHub CLI](https://cli.github.com) (`gh`) | heatmap, pull requests | Must be logged in: `gh auth login`. Pulse uses your active `gh` account. |
| `git` | git panel | |
| [Claude Code](https://claude.com/claude-code) (`claude`) | commit messages | Optional. Only the **message** button needs it, and it uses your existing Claude Code login. |
| `pbcopy` (macOS), or `wl-copy`, `xclip` or `xsel` (Linux) | copying PR links | |

Pulse runs on macOS and Linux.

## Install

```sh
herdr plugin install matiaz/herdr-pulse
```

Herdr shows the manifest before installing. Pulse runs no build commands.

To update, run the same command again. Herdr replaces the managed checkout.

## Opening and closing the dock

Pulse opens on the right edge of the focused tab when Herdr starts. To toggle it yourself, bind the toggle action to a key in `~/.config/herdr/config.toml`:

```toml
[[keys.command]]
key = "prefix+a"
type = "plugin_action"
command = "matiaz.pulse.toggle"
description = "toggle pulse"
```

Or run it from any shell inside Herdr:

```sh
herdr plugin action invoke toggle --plugin matiaz.pulse
```

The dock opens per tab, and focus stays on the pane you were using.

## Panels

### Activity heatmap

Weeks run left to right, weekdays top to bottom, and today is green. Days with no activity are dim squares. Hover over a day to see its exact value.

- **GitHub** shows the contribution counts from your GitHub profile calendar, for the account `gh` is logged into.
- **Claude Code** shows the estimated cost per day of your Claude Code usage. Pulse reads it from the session transcripts in `~/.claude/projects` on this computer and prices it at public API rates. It is an estimate of what the usage would cost on the API, not a bill, and it only covers this computer.

Claude Code deletes transcripts older than 30 days by default. From the first time you run Pulse onward, it keeps its own daily totals, so the calendar keeps that history.

### Pull requests

The list has every open PR where you are the author, an assignee, or a requested reviewer. The most urgent ones come first:

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

Click a PR to copy its URL. Double-click to open it in your browser. The list refreshes every 2 minutes.

### Git

The git panel follows the pane you are focused on in the same tab. It shows only when that pane's folder is inside a git repository with a GitHub remote.

Each changed file shows what happened to it and whether it is staged:

- `modified` in yellow, `added` and `new` in green, `deleted` and `conflict` in red, `renamed` in blue. `new` is a file git is not tracking yet.
- `●` staged, `◐` partly staged, `○` not staged.

The buttons:

- **stage all** runs `git add -A`.
- **message** asks Claude (the Haiku model) for a one- or two-sentence commit message and shows it below the buttons as `branch: message`.
- **commit** commits the staged files with that message, or with just the branch name if you did not generate one. It stays disabled until something is staged.

While an action runs, a hexagon animation shows what is happening and every button is disabled, so a double tap cannot commit twice.

## Controls

| Input | Action |
| --- | --- |
| `←` `→` or `h` `l` | Scroll the heatmap one week |
| `[` `]` | Scroll the heatmap four weeks |
| Mouse wheel | Scroll whatever is under the pointer |
| `0` or `g` | Jump the heatmap back to today |
| `t`, `Tab`, or click `⇄` | Switch the heatmap between GitHub and Claude Code |
| `r` | Refresh everything now |
| `↑` `↓` in a box title, or drag a title onto another box | Move a box up or down |
| `q` | Close the dock |

## Privacy and data

Pulse keeps everything on your computer and has no server of its own.

- **What it stores.** Caches and preferences go in Herdr's plugin state directory: `~/.local/state/herdr/plugins/matiaz.pulse/`. That is your contribution counts, your daily Claude Code cost totals, your open PR list, the panel order and the dock width. Nothing is ever written to the plugin's own folder.
- **What it sends to GitHub.** Read-only GraphQL queries through your `gh` login: your contribution calendar and your open pull requests.
- **What it sends to Anthropic.** Nothing, unless you press **message**. Then the staged diff (or the unstaged diff if nothing is staged), cut to 24 KB, and the list of changed file names go to Claude through your Claude Code login. Files that commonly hold secrets or noise are left out of the diff: `.env*`, `*.pem`, `*.key`, `*.p12`, SSH keys, anything with `secret` in its name, and lockfiles. Their names can still appear in the file list. The request runs without tools, hooks, MCP servers or session history.
- **What it runs.** `gh`, `git`, `claude`, `herdr`, and your clipboard and browser openers. It runs them directly, never through a shell. Git runs with `core.fsmonitor` turned off, without external diff or textconv drivers and without taking the index lock, so watching a repository never runs that repository's configured programs or blocks your own git commands.
- **What it shows.** PR titles, branch names and file names come from other people's repositories, so Pulse strips terminal control characters from them before drawing.

To remove all local data, delete the state directory above.

## How it is built

```
herdr-plugin.toml   manifest: the dock pane, the toggle action, the startup hook
bin/run.sh          puts common install locations on PATH, then runs node
app.mjs             the dock: layout, boxes, mouse and keyboard
dock.mjs            opens, closes and sizes the dock pane through the herdr CLI
sections/           one file per panel: what it draws and how it reacts to input
sources/            data for each panel: GitHub, Claude Code transcripts, pull requests, git
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
