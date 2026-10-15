---
name: skulk
description: >-
  Wait for something without sleep-polling: schedule an OpenCode session wake-up with skulk.
  Use whenever an agent needs to wait for CI, GitHub Actions runs, pull request checks, an npm
  publish, a deploy, an approval, another agent session or watch to finish, a long-running
  command to exit, the machine to have capacity for heavy work, or a time of day. Use it instead
  of `sleep` loops, repeated polling, or asking the user to check back later.
---

# skulk

skulk queues one message into an OpenCode session when a time arrives or an event happens. A small daemon owns every watch, so the agent ends its turn and pays nothing while it waits. The message names the watch, says what changed, and repeats your `--do` instruction.

The target session defaults to `$OPENCODE_SESSION_ID` (the calling session), so `skulk ... --do "..."` wakes the agent that ran it. Pass `--session ses_…` to wake a different session. Outside OpenCode, pass an `https://` webhook URL as `--session` (or set `$SKULK_WEBHOOK`) and the daemon POSTs the wake there; keep that URL out of messages and commits, since it usually carries a token.

Check it's installed and the daemon is running with `skulk status`. If it isn't, see https://github.com/kitlangton/skulk#install.

## When to use it

- You're about to `sleep`, poll in a loop, or tell the user "check back later": schedule a wake and end your turn instead.
- Prefer a built-in trigger (`skulk when …`) over a hand-written `skulk poll`. Built-ins check every 10–15s and put the result (conclusion, failed jobs, versions) in the wake message.
- For multi-step waits, schedule the next wake from the woken session instead of chaining waits up front.

## Triggers

```sh
# Timers
skulk in 2h --do "Check whether the staging deploy finished and report."
skulk at "tomorrow 9:00" --name standup --do "Summarize yesterday's merged PRs."

# GitHub Actions run: by run ID, workflow + commit, or PR
skulk when gh-run --repo owner/app --workflow release.yml --sha 41b03de --name release-41b03de \
  --do "If the release run passed, verify the npm version; if it failed, read the failed job logs and fix it."

# Every check on a pull request (--required for only required checks)
skulk when pr-checks --repo owner/app --pr 123 --name ci-123 \
  --do "PR 123 CI finished: fix any failures, otherwise report green."

# npm publish: a tag changes, a version newer than X, or anything published after a time
skulk when npm --package @scope/client --tag latest --changes --name client-latest \
  --do "Bump @scope/client in this repo to the new version and run the tests."

# A command that blocks until the event, e.g. a deploy or run watcher
skulk when exits --name deploy-watch --timeout 30m --do "The deploy command exited: check its output." \
  -- gh run watch 38007696000 --exit-status

# Other OpenCode sessions finish, or other watches end
skulk when idle ses_abc ses_def --do "Both agents are done: review and merge their branches."
skulk when done ci-123 release-41b03de --do "CI and release both ended: summarize the results."

# The machine has room for heavy work (needs $SKULK_CAPACITY_COMMAND; see the README)
skulk when capacity --slot heavy --name bench --do "Capacity granted: run the benchmarks, then run skulk release."

# Custom poll when nothing built-in fits (minimum interval 60s)
skulk poll --every 5m --changes --from PENDING --name approval \
  --do "The approval was decided: continue the rollout if approved." \
  -- 'my-cli status --json | jq -r .status'
```

Poll conditions: `--changes [--from V]`, `--equals V`, `--matches REGEX`, `--succeeds`. A failing or empty check never counts as a change, so a logged-out CLI can't cause a false wake. Every watch takes `--deadline` (default 48h, max 14d) and wakes you if it expires.

## Writing `--do`

The woken session may have lost context, so make `--do` self-contained: include the repo, PR or run number, links, branch names, and exactly what to do on success and on failure. Give every watch a short `--name` so it can be inspected and cancelled.

## Inspect and cancel

```sh
skulk list                 # open watches with next check and last value
skulk show <name>          # full state: last check, value, failures, delivery
skulk logs <name>          # per-check log (-f to follow)
skulk cancel <name>
skulk release              # end slot holds from `when capacity --slot`
```

## Subagents and agents that can't end their turn

A wake arrives as a new message after the session goes idle. A subagent finishes when its turn ends, so it should block instead:

```sh
skulk when pr-checks --repo owner/app --pr 123 --wait   # prints the result; exit 1 unless it fired
skulk wait ci-123                                       # follow an existing watch
skulk run --slot heavy -- cargo build --release         # wait for capacity and a slot, run, release
```

Give long blocking commands a long shell timeout so the harness doesn't background or kill them.

## Environment and secrets

`skulk poll` and `skulk when exits` commands run later under the **daemon's** environment, in the directory where the watch was created, with the `PATH` captured at creation. They don't get the creating shell's other variables, and the command is stored in skulk's database. Never inline secrets: let the command fetch its own credentials (a CLI's own login, the keychain, a password manager CLI).

## Security

`skulk poll` and `skulk when exits` store a command the daemon runs later as the user, outside the agent's permission prompt. Don't add a blanket `skulk *` allow rule. Allow only the subcommands that can't run commands (`in`, `at`, `when gh-run|pr-checks|npm|capacity|idle|done`, `wait`, `list`, `show`, `logs`, `cancel`, `release`), and keep `skulk poll`, `skulk when exits` and `skulk run` on ask. `SKULK_ALLOW_EXEC=0` in the daemon's environment disables command watches entirely; timers and built-in triggers keep working.
