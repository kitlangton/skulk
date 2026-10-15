#!/usr/bin/env bun
import { existsSync, readFileSync } from "node:fs"
import { join, resolve } from "node:path"
import { parseArgs } from "node:util"
import { evaluate } from "./condition.ts"
import { displayCommand } from "./message.ts"
import { exitsWatch, pollWatch, timerWatch, whenWatch } from "./create.ts"
import { checkBuiltin, describeCapacity, parseCapacity } from "./builtin.ts"
import { daemonPID, nudge, runDaemon } from "./daemon.ts"
import { env } from "./env.ts"
import { fileLogger, logPath } from "./engine.ts"
import { legacyStateDirectory, Store } from "./store.ts"
import { displayTarget, isWebhook } from "./webhook.ts"
import { allowExec, builtinDeps, capacityCommand, defaultPath, launchdLabel, probeCapacity, runWatch, sessionExists, watchID } from "./system.ts"
import { clip, formatDuration, formatTime, parseDuration, parseTime, redact, relative } from "./text.ts"
import { describeCondition, isEventBuiltin, isOpen, Limits, type Builtin, type Condition, type Watch } from "./watch.ts"

const usage = `skulk: wake an OpenCode session at a time, or when an external event or polled condition holds.
(\`wake\` is an alias for \`skulk\`.)

Timers
  skulk in <duration> --do <instruction> [--name N] [--session S]
  skulk at <time>    --do <instruction> [--name N] [--session S]
      duration: 90s, 20m, 2h30m, 1d     time: 15:30, 3pm, tomorrow 9:00, 2026-10-10 09:00

Built-in conditions (evaluated by the daemon; no probe script to write)
  skulk when gh-run --repo OWNER/REPO (--run ID | --workflow FILE --sha SHA | --pr N [--workflow FILE]) --do <instruction>
      waits for the GitHub Actions run to appear and complete (adaptive 10–15s checks); reports
      the conclusion, failed job names and run URL
  skulk when pr-checks --repo OWNER/REPO --pr N [--required] --do <instruction>
      waits for PR checks to finish (default every 15s); reports pass and fail check names
  skulk when npm --package NAME (--tag TAG --changes [--from V] | --newer-than VERSION | --published-after TIME) --do <instruction>
      waits for an npm version to publish (default every 15s); reports version and publish time
  skulk when exits --do <instruction> [--timeout D] [--deadline D] -- <blocking command...>
      runs a blocking command (e.g. \`gh run watch <id> --exit-status\`), re-runs across daemon
      restarts, and wakes when it exits with the exit code and output tail
  skulk when capacity --do <instruction> [--slot heavy] [--cpu 70] [--builds 1] [--disk 20] [--stable 3m]
      the Mac has room: 3-minute CPU mean ≤ --cpu %, at most --builds xcodebuilds, ≥ --disk GB free,
      holding steadily for --stable. Read from \`${capacityCommand()}\` (set $SKULK_CAPACITY_COMMAND).
  skulk when idle <ses_…>... --do <instruction> [--stable 2m]
      every listed OpenCode session has finished its run and stayed idle for --stable
  skulk when done <id|name>... --do <instruction>
      every listed watch has ended (fired, expired, failed or was cancelled)
  Built-in watches take --every (default 15s for gh-run/pr-checks/npm, 1m for capacity/idle/done),
  --deadline, --failures, --no-check, --name and --session.

Polls (one wake when the condition holds, then the watch ends)
  skulk poll --every <duration> <condition> --do <instruction> [options] -- <command...>
      conditions: --changes [--from VALUE]  output differs from VALUE (or from the first reading)
                  --equals VALUE            output equals VALUE
                  --matches REGEX           output matches REGEX
                  --succeeds                command exits 0
      options:    --deadline 48h   give up after this long (max 14d); the session is told
                  --failures 5     wake with an error after this many consecutive failed checks
                  --timeout 2m     per-check timeout (max 10m)
                  --cwd DIR        working directory for the command (default: current)
                  --no-check       skip the check that runs once at creation
      A single argument after -- runs through /bin/sh -c; several run as argv. The compared value is
      trimmed stdout. For value conditions a non-zero exit or empty output counts as a failed check.

Slots (one place at a time, first come first served)
  --slot NAME [--hold 2h]          on \`when\` or \`poll\`: once the condition holds, wait for a place in
                                   NAME, then wake. Each grant restarts the other waiters' --stable
                                   window. The place is held until \`skulk release\`, the woken session
                                   goes idle (after a 2m grace), or --hold expires (max 12h).
  skulk release [id|name|slot]     end a hold (default: every hold of this session)
  skulk slots                      sizes, holders and queues
  skulk slot NAME --size N         places in NAME (default: heavy 2, others 1)

Foreground waits (no session prompt; for agents that cannot end their turn, e.g. subagents)
  --wait                           on \`in\`, \`at\`, \`when\` or \`poll\`: block until the watch ends and print
                                   its result (exit 1 unless it fired). Without --do nothing is
                                   queued into a session; Ctrl-C cancels the watch.
  skulk wait <id|name>             block until an existing watch ends
  skulk run [--slot heavy] [capacity flags] -- <cmd>
                                   wait for capacity and a place in the slot, run <cmd> in the
                                   foreground, then release the slot; exits with <cmd>'s code

Manage
  skulk list [--all] [--json]      open watches (--all adds finished ones)
  skulk show <id|name> [--json]
  skulk cancel <id|name>...
  skulk logs <id|name> [-n 50] [--follow]
  skulk status                     daemon state
  skulk daemon                     run the supervisor (launchd runs this)
  skulk launchd [--label L]        print the LaunchAgent plist (honours $SKULK_HOME)

The target session defaults to $OPENCODE_SESSION_ID (the calling OpenCode session), then $SKULK_WEBHOOK.
--session also takes an https:// webhook URL, which receives the wake as a JSON POST. Limits: polls at
most every 60s (15s default for event built-ins), ${Limits.maxActive} open watches, deadlines up to 14 days. State
and logs live in ${"$"}SKULK_HOME (default ~/.local/state/skulk), owner-only. SKULK_* variables also accept
their pre-rename WAKE_* names.`

function fail(message: string): never {
  console.error(`skulk: ${message}`)
  process.exit(1)
}

const argv = process.argv.slice(2)
const separator = argv.indexOf("--")
const own = separator === -1 ? argv : argv.slice(0, separator)
const command = separator === -1 ? [] : argv.slice(separator + 1)

const { values: flags, positionals } = (() => {
  try {
    return parseArgs({
      args: own,
      allowPositionals: true,
      options: {
        do: { type: "string" },
        name: { type: "string" },
        session: { type: "string" },
        every: { type: "string" },
        changes: { type: "boolean" },
        from: { type: "string" },
        equals: { type: "string" },
        matches: { type: "string" },
        succeeds: { type: "boolean" },
        deadline: { type: "string" },
        failures: { type: "string" },
        timeout: { type: "string" },
        cwd: { type: "string" },
        "no-check": { type: "boolean" },
        all: { type: "boolean" },
        json: { type: "boolean" },
        follow: { type: "boolean", short: "f" },
        n: { type: "string", short: "n" },
        label: { type: "string" },
        slot: { type: "string" },
        hold: { type: "string" },
        cpu: { type: "string" },
        builds: { type: "string" },
        disk: { type: "string" },
        stable: { type: "string" },
        size: { type: "string" },
        repo: { type: "string", short: "R" },
        run: { type: "string" },
        workflow: { type: "string", short: "w" },
        sha: { type: "string" },
        pr: { type: "string" },
        required: { type: "boolean" },
        package: { type: "string" },
        tag: { type: "string" },
        "newer-than": { type: "string" },
        "published-after": { type: "string" },
        wait: { type: "boolean", short: "W" },
        help: { type: "boolean", short: "h" },
      },
    })
  } catch (error) {
    fail(`${(error as Error).message}\n\n${usage}`)
  }
})()

const [verb, ...rest] = positionals
if (!verb || flags.help || verb === "help") {
  console.log(usage)
  process.exit(0)
}

// Only these run a command, so allowlisted subcommands (`skulk in`, `skulk when gh-run`, …) cannot carry one.
const runsCommand = verb === "poll" || verb === "run" || (verb === "when" && rest[0] === "exits")
if (separator !== -1 && !runsCommand) fail(`\`skulk ${verb}${verb === "when" && rest[0] ? ` ${rest[0]}` : ""}\` takes no command after --`)
if (runsCommand && verb !== "run" && !allowExec())
  fail("SKULK_ALLOW_EXEC=0: command watches are disabled; use a built-in condition (skulk when …) or a timer")

const store = new Store()

function resolveWatch(ref: string | undefined) {
  if (!ref) fail("which watch? give an ID or name")
  return store.find(ref) ?? fail(`no watch ${ref}`)
}

function daemonWarning() {
  return daemonPID(store.root) === undefined
    ? "\n⚠ the skulk daemon is not running, so nothing will fire until it starts (see `skulk status`)."
    : ""
}

/** A foreground wait without --do resolves locally and never prompts a session. */
const noDeliver = () => Boolean(flags.wait && !flags.do)

async function targetSession() {
  const sessionID = flags.session ?? process.env.OPENCODE_SESSION_ID ?? env("WEBHOOK") ?? (noDeliver() ? "ses_localwait" : undefined)
  if (!sessionID) fail("no target session: pass --session ses_… or an https:// webhook (or set $SKULK_WEBHOOK, or pass --wait)")
  if (noDeliver() || isWebhook(sessionID)) return { sessionID, title: undefined }
  const found = await sessionExists(sessionID).catch((error: Error) => fail(error.message))
  if (!found.exists) fail(`session ${sessionID} does not exist`)
  return { sessionID, title: found.title }
}

/** Blocks until the watch ends. When this process created it, a signal cancels it. */
async function waitForWatch(watchID: string, cancelOnSignal: boolean): Promise<Watch> {
  const cleanup = () => {
    if (cancelOnSignal) {
      const current = store.get(watchID)
      if (current && isOpen(current) && store.update({ ...current, status: "cancelled", endedAt: Date.now() }, current.status))
        fileLogger(store.root)(watchID, "cancelled by signal during --wait")
      store.release(watchID)
      nudge(store.root)
    }
    process.exit(130)
  }
  process.once("SIGINT", cleanup)
  process.once("SIGTERM", cleanup)
  try {
    while (true) {
      const current = store.get(watchID)
      if (!current) fail(`watch ${watchID} disappeared`)
      if (!isOpen(current)) return current
      await Bun.sleep(waitPollMs)
    }
  } finally {
    process.off("SIGINT", cleanup)
    process.off("SIGTERM", cleanup)
  }
}

const waitPollMs = 500

function printResult(finished: Watch) {
  if (flags.json) console.log(JSON.stringify(finished, null, 2))
  else console.log(finished.wakeText ?? finished.lastValue ?? finished.status)
  if (finished.status !== "done") process.exit(1)
}

function summary(watch: Watch, title: string | undefined) {
  const target = `${displayTarget(watch.sessionID)}${title ? ` (${title})` : ""}`
  if (watch.kind === "timer")
    return `Created ${watch.id} (${watch.name}): wakes ${target} at ${formatTime(watch.dueAt)} (${relative(watch.dueAt, Date.now())}).`
  const action =
    watch.condition?.type === "exits"
      ? `runs \`${clip(displayCommand(watch.command ?? []), 120)}\` ${describeCondition(watch.condition)}`
      : `checks every ${formatDuration(watch.intervalMs!)} ${describeCondition(watch.condition)}`
  const lines = [
    `Created ${watch.id} (${watch.name}): ${action}, then wakes ${target}.`,
    `Deadline ${formatTime(watch.deadlineAt)} (${relative(watch.deadlineAt, Date.now())}).`,
  ]
  if (watch.slot) lines.push(`Then queues for slot ${watch.slot} (${store.slotSize(watch.slot)} places, ${store.holds(watch.slot).length} held, hold up to ${formatDuration(watch.holdMs!)}).`)
  if (watch.lastValue) lines.push(`Current value: ${clip(watch.lastValue, 200)}`)
  return lines.join("\n")
}

async function created(watch: Watch, title: string | undefined) {
  if (flags.wait) watch.ownerPID = process.pid
  parseOr(() => store.insertChecked(watch, Limits.maxActive))
  fileLogger(store.root)(
    watch.id,
    `created ${watch.kind} ${watch.name} for ${displayTarget(watch.sessionID)} by ${watch.createdBy ?? `pid ${process.ppid}`}` +
      (watch.command
        ? ` in ${watch.cwd}: ${clip(displayCommand(watch.command), 500)} ${describeCondition(watch.condition)} every ${formatDuration(watch.intervalMs!)}`
        : ` at ${new Date(watch.dueAt).toISOString()}`),
  )
  if (watch.checks > 0)
    fileLogger(store.root)(watch.id, `check 1 (at creation): exit ${watch.lastExit} value ${clip(watch.lastValue ?? "", 200)}`)
  nudge(store.root)
  if (flags.wait) {
    if (!flags.json) console.error(summary(watch, title) + daemonWarning())
    return printResult(await waitForWatch(watch.id, true))
  }
  if (flags.json) console.log(JSON.stringify(watch, null, 2))
  else console.log(summary(watch, title) + daemonWarning())
}

function condition(): Condition {
  const chosen = [flags.changes, flags.equals !== undefined, flags.matches !== undefined, flags.succeeds].filter(Boolean)
  if (chosen.length !== 1) fail("pick exactly one of --changes, --equals, --matches, --succeeds")
  if (flags.from !== undefined && !flags.changes) fail("--from goes with --changes")
  if (flags.changes) return { type: "changes", from: flags.from }
  if (flags.equals !== undefined) return { type: "equals", value: flags.equals }
  if (flags.matches !== undefined) return { type: "matches", pattern: flags.matches }
  return { type: "succeeds" }
}

function parseOr<T>(parse: () => T) {
  try {
    return parse()
  } catch (error) {
    fail((error as Error).message)
  }
}

const normalizeCommand = (args: readonly string[]) => (args.length === 1 ? ["/bin/sh", "-c", args[0]!] : [...args])

const commonInput = (sessionID: string, now = Date.now()) => ({
  id: watchID(),
  name: flags.name,
  sessionID,
  instruction: flags.do ?? "",
  now,
  createdBy: process.env.OPENCODE_SESSION_ID,
  noDeliver: noDeliver(),
})

const timingFlags = () => ({
  deadlineMs: flags.deadline ? parseDuration(flags.deadline) : undefined,
  timeoutMs: flags.timeout ? parseDuration(flags.timeout) : undefined,
  maxFailures: flags.failures ? Number(flags.failures) : undefined,
})

async function createTimer(at: number) {
  const target = await targetSession()
  const watch = parseOr(() => timerWatch({ ...commonInput(target.sessionID), at }))
  await created(watch, target.title)
}

async function createPoll() {
  if (!flags.every) fail("--every is required")
  const cond = condition()
  const target = await targetSession()
  const watch = parseOr(() =>
    pollWatch({
      ...commonInput(target.sessionID),
      command: normalizeCommand(command),
      condition: cond,
      intervalMs: parseDuration(flags.every!),
      ...timingFlags(),
      cwd: resolve(flags.cwd ?? process.cwd()),
      path: process.env.PATH,
      ...queueFlags(),
    }),
  )
  if (!flags["no-check"]) {
    const result = await runWatch(watch)
    const check = evaluate(cond, result, undefined)
    if (check.type === "error")
      fail(`the first check failed (${clip(check.error)}); fix the command, or pass --no-check to start anyway`)
    if (check.type === "met")
      fail(`the condition already holds (value: ${clip(check.value, 200)}); nothing to wait for`)
    Object.assign(watch, {
      checks: 1,
      lastCheckAt: Date.now(),
      lastExit: result.exitCode ?? undefined,
      lastValue: check.value.slice(0, 4000),
      baseline: check.baseline,
      dueAt: Date.now() + watch.intervalMs!,
    })
  }
  await created(watch, target.title)
}

function queueFlags() {
  return {
    slot: flags.slot,
    holdMs: flags.hold ? parseOr(() => parseDuration(flags.hold!)) : undefined,
  }
}

const number = (flag: string | undefined, fallback: number, name: string) => {
  if (flag === undefined) return fallback
  const value = Number(flag)
  if (!Number.isFinite(value)) fail(`--${name} must be a number`)
  return value
}

const capacityCondition = (): Builtin => ({
  type: "capacity",
  cpu: number(flags.cpu, 70, "cpu"),
  builds: number(flags.builds, 1, "builds"),
  diskGB: number(flags.disk, 20, "disk"),
  stableMs: flags.stable === "0" ? 0 : parseOr(() => parseDuration(flags.stable ?? "3m")),
})

/** Refuse a capacity watch whose probe cannot be read, and show the current reading. */
async function readCapacity(watch: Watch) {
  const result = await probeCapacity(watch)
  const capacity = result.exitCode === 0 ? parseCapacity(result.stdout) : undefined
  if (!capacity) fail(`could not read capacity from \`${capacityCommand()}\` (${clip((result.error ?? result.stderr) || result.stdout, 200)})`)
  watch.lastValue = describeCapacity(capacity)
}

async function createWhen(kind: string | undefined, args: readonly string[]) {
  if (kind === "exits") {
    if (args.length) fail("pass the blocking command after -- : skulk when exits --do <instruction> -- <command...>")
    const target = await targetSession()
    const watch = parseOr(() =>
      exitsWatch({
        ...commonInput(target.sessionID),
        command: normalizeCommand(command),
        ...timingFlags(),
        cwd: resolve(flags.cwd ?? process.cwd()),
        path: process.env.PATH,
        ...queueFlags(),
      }),
    )
    await created(watch, target.title)
    return
  }

  const now = Date.now()
  const stableMs = (fallback: string) => parseOr(() => parseDuration(flags.stable ?? fallback))
  let condition: Builtin
  if (kind === "capacity") {
    if (args.length) fail("skulk when capacity takes no arguments")
    condition = capacityCondition()
  } else if (kind === "idle") condition = { type: "idle", sessions: [...args], stableMs: flags.stable === "0" ? 0 : stableMs("2m") }
  else if (kind === "done") {
    const watches = args.map((ref) => {
      const watch = resolveWatch(ref)
      if (!isOpen(watch)) fail(`${watch.id} (${watch.name}) has already ended`)
      return watch.id
    })
    condition = { type: "done", watches }
  } else if (kind === "gh-run") {
    if (args.length) fail("skulk when gh-run takes flags (--repo, --run, --workflow, --sha, --pr)")
    const pr = flags.pr !== undefined ? number(flags.pr, 0, "pr") : undefined
    condition = {
      type: "gh-run",
      repo: flags.repo ?? "",
      runID: flags.run,
      workflow: flags.workflow,
      sha: flags.sha,
      pr,
    }
  } else if (kind === "pr-checks") {
    if (args.length) fail("skulk when pr-checks takes flags (--repo, --pr, [--required])")
    condition = {
      type: "pr-checks",
      repo: flags.repo ?? "",
      pr: flags.pr !== undefined ? number(flags.pr, 0, "pr") : 0,
      required: flags.required || undefined,
    }
  } else if (kind === "npm") {
    const pkg = flags.package ?? args[0] ?? ""
    if (args.length > (flags.package ? 0 : 1)) fail("skulk when npm --package NAME (--tag TAG --changes | --newer-than VERSION | --published-after TIME)")
    const modes = [Boolean(flags.changes), flags["newer-than"] !== undefined, flags["published-after"] !== undefined].filter(Boolean).length
    if (modes !== 1) fail("pick one of --changes (with --tag TAG), --newer-than VERSION, or --published-after TIME")
    if (flags.from !== undefined && !flags.changes) fail("--from goes with --changes")
    const publishedAfter = flags["published-after"] !== undefined ? parseOr(() => parseTime(flags["published-after"]!, now)) : undefined
    condition = {
      type: "npm",
      pkg,
      tag: flags.tag ?? (flags.changes ? "latest" : undefined),
      mode: flags.changes ? "changes" : flags["newer-than"] !== undefined ? "newer-than" : "published-after",
      from: flags.from,
      newerThan: flags["newer-than"],
      publishedAfter,
    }
  } else fail("skulk when capacity|idle|done|gh-run|pr-checks|npm|exits …")
  const target = await targetSession()
  const watch = parseOr(() =>
    whenWatch({
      ...commonInput(target.sessionID, now),
      condition,
      intervalMs: flags.every ? parseDuration(flags.every) : undefined,
      deadlineMs: flags.deadline ? parseDuration(flags.deadline) : undefined,
      maxFailures: flags.failures ? Number(flags.failures) : undefined,
      ...queueFlags(),
    }),
  )
  watch.path = process.env.PATH
  if (condition.type === "capacity") await readCapacity(watch)
  if (condition.type === "idle")
    for (const session of condition.sessions) {
      const found = await sessionExists(session).catch((error: Error) => fail(error.message))
      if (!found.exists) fail(`session ${session} does not exist`)
    }
  if (isEventBuiltin(condition) && !flags["no-check"]) {
    const initial = await checkBuiltin(watch, condition, builtinDeps(store), Date.now())
    if (initial.check.type === "error")
      fail(`the first check failed (${clip(initial.check.error)}); fix the arguments, or pass --no-check to start anyway`)
    watch.lastValue = initial.check.value.slice(0, 4000)
    if (initial.check.type === "pending") {
      watch.checks = 1
      watch.lastCheckAt = Date.now()
      if (initial.check.baseline !== undefined) watch.baseline = initial.check.baseline
      watch.dueAt = Date.now() + (initial.nextIntervalMs ?? watch.intervalMs!)
    }
  }
  await created(watch, target.title)
}

/** `skulk run`: wait for capacity and a slot place, run the command here, then release the place. */
async function runWithSlot() {
  if (command.length === 0) fail("give the command to run after -- : skulk run [--slot heavy] -- <command...>")
  const slot = flags.slot ?? "heavy"
  const watch = parseOr(() =>
    whenWatch({
      ...commonInput(flags.session ?? process.env.OPENCODE_SESSION_ID ?? "ses_localrun"),
      instruction: "(skulk run)",
      noDeliver: true,
      condition: capacityCondition(),
      intervalMs: flags.every ? parseDuration(flags.every) : undefined,
      deadlineMs: flags.deadline ? parseDuration(flags.deadline) : undefined,
      maxFailures: flags.failures ? Number(flags.failures) : undefined,
      slot,
      holdMs: flags.hold ? parseDuration(flags.hold) : undefined,
    }),
  )
  watch.path = process.env.PATH
  watch.ownerPID = process.pid
  await readCapacity(watch)
  parseOr(() => store.insertChecked(watch, Limits.maxActive))
  fileLogger(store.root)(watch.id, `created skulk run ${watch.name} for ${displayTarget(watch.sessionID)} (slot ${slot}): ${clip(displayCommand(normalizeCommand(command)), 500)}`)
  nudge(store.root)
  if (!flags.json) console.error(`skulk run: waiting for capacity and a place in ${slot} (${watch.id})${daemonWarning()}`)
  const granted = await waitForWatch(watch.id, true)
  if (granted.status !== "done") {
    console.error(granted.wakeText ?? `skulk: ${granted.status}`)
    process.exit(1)
  }
  try {
    const child = Bun.spawn(normalizeCommand(command), { cwd: resolve(flags.cwd ?? process.cwd()), stdin: "inherit", stdout: "inherit", stderr: "inherit" })
    const forward = (signal: NodeJS.Signals) => () => child.kill(signal)
    const onInt = forward("SIGINT")
    const onTerm = forward("SIGTERM")
    process.on("SIGINT", onInt)
    process.on("SIGTERM", onTerm)
    process.exitCode = await child.exited
    process.off("SIGINT", onInt)
    process.off("SIGTERM", onTerm)
  } finally {
    if (store.release(watch.id)) {
      fileLogger(store.root)(watch.id, `released slot ${slot}: skulk run finished`)
      nudge(store.root)
    }
  }
}

function release(ref: string | undefined) {
  const session = process.env.OPENCODE_SESSION_ID
  const watch = ref ? store.find(ref) : undefined
  const holds = watch
    ? store.holds().filter((hold) => hold.watchID === watch.id)
    : store.holds(ref).filter((hold) => !session || hold.sessionID === session)
  if (!watch && !session && ref === undefined) fail("which hold? give a watch ID or name (or run inside OpenCode)")
  if (holds.length === 0) return console.log(ref ? `No hold for ${ref}${!watch && session ? " in this session" : ""}.` : "This session holds no slots.")
  for (const hold of holds) {
    if (store.release(hold.watchID)) {
      fileLogger(store.root)(hold.watchID, `released slot ${hold.slot}: skulk release`)
      console.log(`Released ${hold.slot} (${hold.watchID}).`)
    }
  }
  nudge(store.root)
}

function slots() {
  const now = Date.now()
  const waiting = store.open().filter((watch) => watch.slot && watch.status === "active")
  const names = [...new Set([...store.holds().map((hold) => hold.slot), ...waiting.map((watch) => watch.slot!), "heavy"])].sort()
  if (flags.json)
    return console.log(JSON.stringify(names.map((slot) => ({ slot, size: store.slotSize(slot), holds: store.holds(slot), queue: waiting.filter((watch) => watch.slot === slot).map((watch) => watch.id) })), null, 2))
  for (const slot of names) {
    const holds = store.holds(slot)
    console.log(`${slot}: ${holds.length}/${store.slotSize(slot)} held`)
    for (const hold of holds) {
      const watch = store.get(hold.watchID)
      console.log(`  held   ${hold.watchID} (${watch?.name ?? "?"}) by ${displayTarget(hold.sessionID)} since ${relative(hold.acquiredAt, now)}, until ${formatTime(hold.expiresAt)}`)
    }
    for (const watch of waiting.filter((other) => other.slot === slot).sort((a, b) => a.createdAt - b.createdAt))
      console.log(`  queued ${watch.id} (${watch.name}) for ${displayTarget(watch.sessionID)}: ${clip(watch.lastValue ?? "not checked yet", 80)}`)
  }
}

function resizeSlot(slot: string | undefined) {
  if (!slot || !/^[\w.:-]{1,32}$/.test(slot)) fail("skulk slot NAME --size N")
  const size = Number(flags.size)
  if (!Number.isInteger(size) || size < 1 || size > 16) fail("--size must be 1–16")
  store.setSlotSize(slot, size)
  console.log(`Slot ${slot} now has ${size} place${size === 1 ? "" : "s"}.`)
  nudge(store.root)
}

function row(watch: Watch, now: number) {
  const next =
    watch.status === "active"
      ? watch.kind === "timer"
        ? `fires ${relative(watch.dueAt, now)}`
        : watch.condition?.type === "exits" && watch.dueAt <= now
          ? "running"
          : `next check ${relative(watch.dueAt, now)}`
      : watch.status === "firing"
        ? "delivering"
        : `${watch.status} ${relative(watch.endedAt ?? watch.firedAt ?? watch.createdAt, now)}`
  const value = watch.kind === "poll" ? clip(watch.lastValue ?? "–", 40) : ""
  return [watch.id, watch.name, displayTarget(watch.sessionID), next, value]
}

function list() {
  const watches = flags.all ? store.list(undefined, 50) : store.open()
  if (flags.json) return console.log(JSON.stringify(watches, null, 2))
  if (watches.length === 0) return console.log(`No ${flags.all ? "" : "open "}watches.${daemonWarning()}`)
  const now = Date.now()
  const rows = [["ID", "NAME", "SESSION", "STATE", "LAST VALUE"], ...watches.map((watch) => row(watch, now))]
  const widths = rows[0]!.map((_, column) => Math.max(...rows.map((cells) => cells[column]!.length)))
  for (const cells of rows) console.log(cells.map((cell, column) => cell.padEnd(widths[column]!)).join("  ").trimEnd())
  const warning = daemonWarning()
  if (warning) console.log(warning.trim())
}

function show(watch: Watch) {
  if (flags.json) return console.log(JSON.stringify(watch, null, 2))
  const now = Date.now()
  const at = (ms: number | undefined) => (ms === undefined ? "–" : `${formatTime(ms)} (${relative(ms, now)})`)
  const lines: [string, string | undefined][] = [
    ["Watch", `${watch.id} (${watch.name})`],
    ["Status", watch.status + (watch.outcome ? `, ${watch.outcome}` : "")],
    ["Session", watch.noDeliver ? `${watch.sessionID} (foreground wait; no prompt)` : displayTarget(watch.sessionID)],
    ["Created", at(watch.createdAt)],
    ["Created by", watch.createdBy ?? (watch.ownerPID ? `pid ${watch.ownerPID}` : undefined)],
    ["Instruction", watch.instruction],
  ]
  if (watch.kind === "timer") lines.push(["Fires", at(watch.dueAt)])
  else
    lines.push(
      ["Command", watch.command ? redact(displayCommand(watch.command)) : undefined],
      ["Directory", watch.cwd],
      [
        "Condition",
        watch.condition?.type === "exits"
          ? `${describeCondition(watch.condition)} (timeout ${formatDuration(watch.timeoutMs ?? Limits.defaultDeadlineMs)})`
          : `${describeCondition(watch.condition)}, every ${formatDuration(watch.intervalMs!)}`,
      ],
      ["Deadline", at(watch.deadlineAt)],
      ["Next check", watch.status === "active" ? at(watch.dueAt) : "–"],
      ["Last check", at(watch.lastCheckAt)],
      ["Last value", watch.lastValue === undefined ? "–" : clip(watch.lastValue, 500)],
      ["Baseline", watch.baseline === undefined ? undefined : clip(watch.baseline, 200)],
      ["Checks", `${watch.checks} (${watch.consecutiveFailures} consecutive failures, limit ${watch.maxFailures})`],
      ["Last error", watch.lastError === undefined ? undefined : clip(watch.lastError, 500)],
      ["Slot", watch.slot ? `${watch.slot}${store.holds().some((hold) => hold.watchID === watch.id) ? `, held until ${at(watch.holdExpiresAt)}` : watch.status === "active" ? ", queued" : ""}` : undefined],
    )
  if (watch.firedAt !== undefined)
    lines.push(
      ["Fired", at(watch.firedAt)],
      ["Delivered", watch.deliveredAt === undefined ? `no (${watch.deliveryAttempts} attempts)` : at(watch.deliveredAt)],
      ["Delivery error", watch.lastDeliveryError === undefined ? undefined : clip(watch.lastDeliveryError, 300)],
      ["Message", watch.wakeMessageID],
    )
  lines.push(["Log", logPath(store.root, watch.id)])
  const width = Math.max(...lines.map(([label]) => label.length))
  for (const [label, value] of lines) if (value !== undefined) console.log(`${label.padEnd(width)}  ${value}`)
}

function cancel(refs: readonly string[]) {
  if (refs.length === 0) fail("which watch? give an ID or name")
  for (const ref of refs) {
    const watch = resolveWatch(ref)
    if (!isOpen(watch)) {
      console.log(`${watch.id} (${watch.name}) is already ${watch.status}`)
      continue
    }
    const now = Date.now()
    if (!store.update({ ...watch, status: "cancelled", endedAt: now }, watch.status)) fail(`${watch.id} changed meanwhile; try again`)
    fileLogger(store.root)(watch.id, "cancelled")
    if (store.release(watch.id)) fileLogger(store.root)(watch.id, "released its slot")
    console.log(`Cancelled ${watch.id} (${watch.name}).`)
  }
  nudge(store.root)
}

async function logs(watch: Watch) {
  const path = logPath(store.root, watch.id)
  if (!existsSync(path)) return console.log(`No log yet for ${watch.id}.`)
  if (flags.follow) {
    const tail = Bun.spawn(["tail", "-n", flags.n ?? "50", "-f", path], { stdout: "inherit", stderr: "inherit" })
    await tail.exited
    return
  }
  const lines = readFileSync(path, "utf8").trimEnd().split("\n")
  console.log(lines.slice(-Number(flags.n ?? 50)).join("\n"))
}

function status() {
  const pid = daemonPID(store.root)
  const open = store.open()
  console.log(pid ? `Daemon running (pid ${pid}).` : "Daemon NOT running. Start it with launchd (see README) or `skulk daemon`.")
  console.log(`${open.length}/${Limits.maxActive} open watches. State: ${store.root}`)
  if (store.root === legacyStateDirectory())
    console.log("Pre-rename state: it moves to ~/.local/state/skulk once the old wake daemon (dev.kitlangton.wake) stops.")
}

const escapeXml = (value: string) =>
  value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;")

function plist() {
  const home = process.env.HOME ?? ""
  const bun = process.execPath
  const cli = resolve(import.meta.dir, "cli.ts")
  const path = defaultPath()
  const log = join(store.root, "daemon.log")
  const label = flags.label ?? launchdLabel()
  console.log(`<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${escapeXml(label)}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${escapeXml(bun)}</string>
    <string>${escapeXml(cli)}</string>
    <string>daemon</string>
  </array>
  <key>WorkingDirectory</key>
  <string>${escapeXml(home)}</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>HOME</key>
    <string>${escapeXml(home)}</string>
    <key>PATH</key>
    <string>${escapeXml(path)}</string>
${env("HOME") ? `    <key>SKULK_HOME</key>\n    <string>${escapeXml(store.root)}</string>\n` : ""}  </dict>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>ThrottleInterval</key>
  <integer>10</integer>
  <key>Umask</key>
  <integer>63</integer>
  <key>StandardOutPath</key>
  <string>${escapeXml(log)}</string>
  <key>StandardErrorPath</key>
  <string>${escapeXml(log)}</string>
</dict>
</plist>`)
}

switch (verb) {
  case "in":
    await createTimer(Date.now() + parseOr(() => parseDuration(rest.join(" ") || fail("skulk in <duration>"))))
    break
  case "at":
    await createTimer(parseOr(() => parseTime(rest.join(" ") || fail("skulk at <time>"), Date.now())))
    break
  case "poll":
    await createPoll()
    break
  case "when":
    await createWhen(rest[0], rest.slice(1))
    break
  case "wait": {
    const target = resolveWatch(rest[0])
    printResult(isOpen(target) ? await waitForWatch(target.id, false) : target)
    break
  }
  case "run":
    await runWithSlot()
    break
  case "release":
    release(rest[0])
    break
  case "slots":
    slots()
    break
  case "slot":
    resizeSlot(rest[0])
    break
  case "list":
  case "ls":
    list()
    break
  case "show":
    show(resolveWatch(rest[0]))
    break
  case "cancel":
  case "rm":
    cancel(rest)
    break
  case "logs":
  case "log":
    await logs(resolveWatch(rest[0]))
    break
  case "status":
    status()
    break
  case "daemon":
    await runDaemon(store)
    break
  case "launchd":
    plist()
    break
  default:
    fail(`unknown command ${verb}\n\n${usage}`)
}
