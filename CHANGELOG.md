# Changelog

Releases are tagged `vX.Y.Z`. Install a release with `herdr plugin install matiaz/herdr-pulse --ref vX.Y.Z`, or follow the default branch and update with `herdr plugin update matiaz.pulse`.

## 0.3.0

Added:

- Settings in `config.json` in the plugin's Herdr config folder: plan limits, heatmap default source, notifications, AI messages, Claude config folder, pull request scope, auto review, review approval, auto merge, merge method and follow-up loop interval.
- Pull request scope: show PRs for repositories open in any Herdr pane (default), only the focused pane's repository, or all.
- Auto review of pull requests that request your review, at most one per refresh.
- Auto merge of pull requests Pulse reviewed, once approved on the head commit, clean and green, with `--match-head-commit`. Off by default.
- Follow-up loop that approves once your feedback is addressed, when reviews may approve.
- The author on each pull request row, and a warning line when an automatic merge failed or was skipped.
- `o` opens the last clicked pull request in the browser.
- Herdr notifications when a pull request becomes ready to merge or its CI fails, and when Pulse starts a review or merges.
- A `pulse` workspace metadata token for the Herdr sidebar with the most urgent pull request count and the 5-hour plan usage.
- A `refresh` plugin action that refreshes every open dock.
- Collapsible boxes, remembered with the box order.
- A 10-minute backoff for plan limits after a 401, 403 or 429.

Changed:

- Reviews no longer approve by default: a clean review leaves a "No issues found." comment unless `reviews.autoApprove` is on.
- The review agent gets no pre-approved tools, so Claude Code asks before it acts.
- A review asks for a second double-click within 3 seconds before it starts.
- Reviews run in a new tab of the Herdr workspace that has the pull request's repository open, when there is one.
- Git hooks no longer run for commits, pulls and pushes made from the dock.
- Git commands no longer inherit your `GIT_*` environment variables.
- Background status pauses for repositories whose local config defines filter drivers or includes, and background fetch runs only when the local config uses known safe keys and never recurses into submodules.
- More secret-looking files are left out of what is sent to Claude.
- Plan limits refresh in every heatmap view, not only the Claude Code view.

## 0.2.0

- Repository discovery in the git box for folders that hold several repositories.
- Claude plan usage limits in the Claude Code heatmap view.
- Push, pull, create PR with a Claude-written description from the repository's PR template, and the remote and CI status of the branch.
- Double-click a pull request to have Claude Code review it.

## 0.1.0

- First release: activity heatmap, pull requests waiting on you, and git status with AI commit messages.
