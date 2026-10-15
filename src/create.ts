import { isWebhook } from "./webhook.ts"
import { isEventBuiltin, Limits, type Builtin, type Condition, type Watch } from "./watch.ts"

interface Common {
  readonly id: string
  readonly name?: string
  readonly sessionID: string
  readonly instruction: string
  readonly now: number
  readonly createdBy?: string
  readonly noDeliver?: boolean
}

const base = (input: Common) => ({
  id: input.id,
  name: input.name?.trim() || input.id,
  sessionID: input.sessionID,
  instruction: input.instruction.trim() || (input.noDeliver ? "(foreground wait)" : ""),
  createdAt: input.now,
  createdBy: input.createdBy,
  status: "active" as const,
  checks: 0,
  consecutiveFailures: 0,
  deliveryAttempts: 0,
  ...(input.noDeliver ? { noDeliver: true } : {}),
})

function validateCommon(input: Common) {
  if (!/^ses_[A-Za-z0-9]+$/.test(input.sessionID) && !isWebhook(input.sessionID))
    throw new Error(`not a session ID or https:// webhook: ${input.sessionID}`)
  if (!input.noDeliver && !input.instruction.trim()) throw new Error("say what to do on wake with --do")
  if (input.name !== undefined && !/^[\w.:-]{1,64}$/.test(input.name))
    throw new Error("--name may use letters, digits, . _ : - (max 64)")
}

export function timerWatch(input: Common & { readonly at: number }): Watch {
  validateCommon(input)
  if (input.at <= input.now) throw new Error("the wake time is in the past")
  if (input.at - input.now > Limits.maxDeadlineMs) throw new Error("timers can be at most 14 days out")
  return { ...base(input), kind: "timer", dueAt: input.at, deadlineAt: input.at }
}

const repoPattern = /^[\w.-]+\/[\w.-]+$/

function pollBounds(input: { readonly deadlineMs?: number; readonly maxFailures?: number }, defaultFailures: number = Limits.defaultMaxFailures) {
  const deadlineMs = input.deadlineMs ?? Limits.defaultDeadlineMs
  if (deadlineMs <= 0 || deadlineMs > Limits.maxDeadlineMs) throw new Error("--deadline must be between 0 and 14d")
  const maxFailures = input.maxFailures ?? defaultFailures
  if (!Number.isInteger(maxFailures) || maxFailures < 1 || maxFailures > 100) throw new Error("--failures must be 1–100")
  return { deadlineMs, maxFailures }
}

export function pollWatch(
  input: Common & Queueing & {
    readonly command: readonly string[]
    readonly condition: Condition
    readonly intervalMs: number
    readonly deadlineMs?: number
    readonly timeoutMs?: number
    readonly maxFailures?: number
    readonly cwd?: string
    readonly path?: string
  },
): Watch {
  validateCommon(input)
  if (input.command.length === 0) throw new Error("give the command to poll after --")
  if (input.intervalMs < Limits.minIntervalMs) throw new Error("--every must be at least 60s")
  const { deadlineMs, maxFailures } = pollBounds(input)
  const timeoutMs = input.timeoutMs ?? Math.min(input.intervalMs, Limits.defaultTimeoutMs)
  if (timeoutMs <= 0 || timeoutMs > Limits.maxTimeoutMs) throw new Error("--timeout must be at most 10m")
  if (input.condition.type === "matches") new RegExp(input.condition.pattern)
  return {
    ...base(input),
    ...queueing(input),
    kind: "poll",
    command: [...input.command],
    cwd: input.cwd,
    path: input.path,
    condition: input.condition,
    intervalMs: input.intervalMs,
    timeoutMs,
    maxFailures,
    dueAt: input.now,
    deadlineAt: input.now + deadlineMs,
  }
}

interface Queueing {
  readonly slot?: string
  readonly holdMs?: number
}

function queueing(input: Queueing) {
  if (input.slot === undefined) {
    if (input.holdMs !== undefined) throw new Error("--hold goes with --slot")
    return {}
  }
  if (!/^[\w.:-]{1,32}$/.test(input.slot)) throw new Error("--slot may use letters, digits, . _ : - (max 32)")
  const holdMs = input.holdMs ?? Limits.defaultHoldMs
  if (holdMs < Limits.minIntervalMs || holdMs > Limits.maxHoldMs) throw new Error("--hold must be between 1m and 12h")
  return { slot: input.slot, holdMs }
}

/** A watch whose condition the daemon evaluates itself: capacity, session idleness, watches ending, GitHub runs/checks, or npm. */
export function whenWatch(
  input: Common & Queueing & { readonly condition: Builtin; readonly intervalMs?: number; readonly deadlineMs?: number; readonly maxFailures?: number },
): Watch {
  validateCommon(input)
  const condition = input.condition
  const event = isEventBuiltin(condition)
  const minInterval = event ? Limits.minEventIntervalMs : Limits.minIntervalMs
  const intervalMs = input.intervalMs ?? (event ? Limits.eventIntervalMs : Limits.minIntervalMs)
  if (intervalMs < minInterval) throw new Error(`--every must be at least ${Math.round(minInterval / 1000)}s`)
  const { deadlineMs, maxFailures } = pollBounds(input)
  if (condition.type === "capacity") {
    if (!(condition.cpu > 0 && condition.cpu <= 100)) throw new Error("--cpu must be 1–100")
    if (!(Number.isInteger(condition.builds) && condition.builds >= 0)) throw new Error("--builds must be a whole number")
    if (!(condition.diskGB >= 0)) throw new Error("--disk must be a number of GB")
  }
  if (condition.type === "idle") {
    if (condition.sessions.length === 0) throw new Error("name the sessions to wait for: skulk when idle ses_… [ses_…]")
    for (const session of condition.sessions) if (!/^ses_[A-Za-z0-9]+$/.test(session)) throw new Error(`not a session ID: ${session}`)
  }
  if (condition.type === "done" && condition.watches.length === 0) throw new Error("name the watches to wait for: skulk when done <id|name>…")
  if (condition.type === "gh-run") {
    if (!repoPattern.test(condition.repo)) throw new Error("--repo must be OWNER/REPO")
    const modes = [condition.runID !== undefined, condition.sha !== undefined, condition.pr !== undefined].filter(Boolean).length
    if (modes !== 1) throw new Error("give one of --run ID, --workflow FILE --sha SHA, or --pr N [--workflow FILE]")
    if (condition.runID !== undefined && (!/^\d+$/.test(condition.runID) || condition.workflow !== undefined))
      throw new Error("--run must be a numeric run ID (without --workflow)")
    if (condition.sha !== undefined) {
      if (!condition.workflow?.trim()) throw new Error("--sha requires --workflow FILE")
      if (!/^[0-9a-fA-F]{7,40}$/.test(condition.sha)) throw new Error("--sha must be a 7–40 character commit SHA")
    }
    if (condition.pr !== undefined && (!Number.isInteger(condition.pr) || condition.pr < 1))
      throw new Error("--pr must be a positive PR number")
  }
  if (condition.type === "pr-checks") {
    if (!repoPattern.test(condition.repo)) throw new Error("--repo must be OWNER/REPO")
    if (!Number.isInteger(condition.pr) || condition.pr < 1) throw new Error("--pr must be a positive PR number")
  }
  if (condition.type === "npm") {
    if (!/^(?:@[\w.-]+\/)?[\w.-]+$/.test(condition.pkg)) throw new Error("--package must be an npm package name")
    if (condition.mode === "newer-than" && !condition.newerThan?.trim()) throw new Error("--newer-than requires a version")
    if (condition.mode === "published-after" && (condition.publishedAfter === undefined || Number.isNaN(condition.publishedAfter)))
      throw new Error("--published-after requires a valid time")
  }
  if ("stableMs" in condition && (condition.stableMs < 0 || condition.stableMs > 60 * 60_000)) throw new Error("--stable must be at most 1h")
  return {
    ...base(input),
    ...queueing(input),
    kind: "poll",
    condition,
    intervalMs,
    maxFailures,
    dueAt: input.now,
    deadlineAt: input.now + deadlineMs,
  }
}

/** A watch that runs a blocking command once and wakes when it exits (re-running on daemon restart). */
export function exitsWatch(
  input: Common & Queueing & {
    readonly command: readonly string[]
    readonly deadlineMs?: number
    readonly timeoutMs?: number
    readonly maxFailures?: number
    readonly cwd?: string
    readonly path?: string
  },
): Watch {
  validateCommon(input)
  if (input.command.length === 0) throw new Error("give the blocking command after --")
  const { deadlineMs, maxFailures } = pollBounds(input, 1)
  const timeoutMs = input.timeoutMs ?? deadlineMs
  if (timeoutMs <= 0 || timeoutMs > Limits.maxDeadlineMs) throw new Error("--timeout must be between 0 and 14d")
  return {
    ...base(input),
    ...queueing(input),
    kind: "poll",
    command: [...input.command],
    cwd: input.cwd,
    path: input.path,
    condition: { type: "exits" },
    intervalMs: Limits.eventIntervalMs,
    timeoutMs: Math.min(timeoutMs, deadlineMs),
    maxFailures,
    dueAt: input.now,
    deadlineAt: input.now + deadlineMs,
  }
}
