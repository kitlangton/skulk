import { env } from "./env.ts"

export type Condition =
  | { readonly type: "changes"; readonly from?: string }
  | { readonly type: "equals"; readonly value: string }
  | { readonly type: "matches"; readonly pattern: string }
  | { readonly type: "succeeds" }
  | { readonly type: "exits" }
  // Built-in conditions are evaluated by the daemon itself; they have no user command.
  | { readonly type: "capacity"; readonly cpu: number; readonly builds: number; readonly diskGB: number; readonly stableMs: number }
  | { readonly type: "idle"; readonly sessions: readonly string[]; readonly stableMs: number }
  | { readonly type: "done"; readonly watches: readonly string[] }
  | {
      readonly type: "gh-run"
      readonly repo: string
      readonly runID?: string
      readonly workflow?: string
      readonly sha?: string
      readonly pr?: number
    }
  | {
      readonly type: "pr-checks"
      readonly repo: string
      readonly pr: number
      readonly required?: boolean
    }
  | {
      readonly type: "gl-pipeline"
      readonly repo: string
      readonly pipelineID?: string
      readonly mr?: number
      readonly ref?: string
      readonly sha?: string
    }
  | {
      readonly type: "npm"
      readonly pkg: string
      readonly tag?: string
      readonly mode: "changes" | "newer-than" | "published-after"
      readonly from?: string
      readonly newerThan?: string
      readonly publishedAfter?: number
    }

export const eventBuiltinTypes = ["gh-run", "pr-checks", "npm", "gl-pipeline"] as const
export const builtinTypes = ["capacity", "idle", "done", ...eventBuiltinTypes] as const

export type EventBuiltin = Extract<Condition, { readonly type: (typeof eventBuiltinTypes)[number] }>
export type Builtin = Extract<Condition, { readonly type: (typeof builtinTypes)[number] }>

export const isBuiltin = (condition: Condition | undefined): condition is Builtin =>
  condition !== undefined && (builtinTypes as readonly string[]).includes(condition.type)

export const isEventBuiltin = (condition: Condition | undefined): condition is EventBuiltin =>
  condition !== undefined && (eventBuiltinTypes as readonly string[]).includes(condition.type)

export type Status = "active" | "firing" | "done" | "expired" | "failed" | "cancelled" | "undeliverable"
export type Outcome = "met" | "timer" | "expired" | "failed"

export interface Watch {
  id: string
  name: string
  sessionID: string
  kind: "timer" | "poll"
  instruction: string
  createdAt: number
  createdBy?: string
  /** Next check for a poll; fire time for a timer. */
  dueAt: number
  deadlineAt: number
  status: Status
  // poll
  command?: string[]
  cwd?: string
  path?: string
  condition?: Condition
  intervalMs?: number
  timeoutMs?: number
  maxFailures?: number
  baseline?: string
  /** When a built-in condition started holding continuously. */
  heldSince?: number
  /** Queue for a shared slot; the wake fires only once a place in the slot is granted. */
  slot?: string
  holdMs?: number
  holdExpiresAt?: number
  lastValue?: string
  lastExit?: number
  lastError?: string
  lastCheckAt?: number
  checks: number
  consecutiveFailures: number
  // wake
  outcome?: Outcome
  firedAt?: number
  previousValue?: string
  wakeMessageID?: string
  wakeText?: string
  deliveryAttempts: number
  nextDeliveryAt?: number
  lastDeliveryError?: string
  deliveredAt?: number
  endedAt?: number
  /** Foreground wait only: resolve in SQLite without queueing an OpenCode session prompt. */
  noDeliver?: boolean
  /** Foreground wait only: the waiting `skulk` process. If it dies, the watch is cancelled and its slot released. */
  ownerPID?: number
}

export const Limits = {
  minIntervalMs: 60_000,
  eventIntervalMs: 15_000,
  minEventIntervalMs: 5_000,
  defaultDeadlineMs: 48 * 3600_000,
  maxDeadlineMs: 14 * 24 * 3600_000,
  maxActive: 20,
  defaultMaxFailures: 5,
  defaultTimeoutMs: 120_000,
  maxTimeoutMs: 10 * 60_000,
  /** Keep retrying an undelivered wake (e.g. OpenCode is down) for this long. */
  deliveryWindowMs: 24 * 3600_000,
  defaultHoldMs: 2 * 3600_000,
  maxHoldMs: 12 * 3600_000,
  /** A woken session gets this long to start working before going idle releases its slot. */
  holdGraceMs: 2 * 60_000,
} as const

/** Default sizes for slots nobody has resized: `heavy` defaults to 2 (or $SKULK_HEAVY_SLOT_SIZE). */
export const defaultSlotSize = (slot: string) => {
  if (slot !== "heavy") return 1
  const size = Number(env("HEAVY_SLOT_SIZE"))
  return Number.isInteger(size) && size >= 1 && size <= 16 ? size : 2
}

export const isOpen = (watch: Watch) => watch.status === "active" || watch.status === "firing"

export const describeCondition = (condition: Condition | undefined) => {
  if (!condition) return "timer"
  switch (condition.type) {
    case "changes":
      return condition.from === undefined ? "until output changes" : `until output changes from ${JSON.stringify(condition.from)}`
    case "equals":
      return `until output equals ${JSON.stringify(condition.value)}`
    case "matches":
      return `until output matches /${condition.pattern}/`
    case "succeeds":
      return "until the command exits 0"
    case "exits":
      return "until the command exits"
    case "capacity":
      return `until the Mac has capacity (CPU ≤${condition.cpu}%, ≤${condition.builds} xcodebuild, ≥${condition.diskGB} GB free, steady ${Math.round(condition.stableMs / 60_000)}m)`
    case "idle":
      return `until ${condition.sessions.join(", ")} ${condition.sessions.length === 1 ? "is" : "are"} idle`
    case "done":
      return `until ${condition.watches.join(", ")} ${condition.watches.length === 1 ? "has" : "have"} ended`
    case "gh-run": {
      const target = condition.runID
        ? `run ${condition.runID}`
        : condition.pr !== undefined
          ? `PR #${condition.pr}${condition.workflow ? ` (${condition.workflow})` : ""}`
          : `${condition.workflow ? `${condition.workflow} ` : ""}@ ${condition.sha?.slice(0, 10)}`
      return `until GitHub Actions ${condition.repo} ${target} completes`
    }
    case "pr-checks":
      return `until ${condition.required ? "required " : ""}PR checks on ${condition.repo}#${condition.pr} finish`
    case "gl-pipeline": {
      const target = condition.pipelineID !== undefined
        ? `pipeline ${condition.pipelineID}`
        : condition.mr !== undefined
          ? `MR !${condition.mr}`
          : condition.sha !== undefined
            ? `${condition.ref ? `${condition.ref}@` : ""}${condition.sha.slice(0, 10)}`
            : (condition.ref ?? "")
      return `until the GitLab pipeline ${condition.repo} ${target} completes`
    }
    case "npm":
      return condition.mode === "changes"
        ? `until npm ${condition.pkg}@${condition.tag ?? "latest"} changes${condition.from ? ` from ${condition.from}` : ""}`
        : condition.mode === "newer-than"
          ? `until npm ${condition.pkg}${condition.tag ? `@${condition.tag}` : ""} is newer than ${condition.newerThan}`
          : `until npm ${condition.pkg}${condition.tag ? `@${condition.tag}` : ""} is published after ${new Date(condition.publishedAfter!).toISOString()}`
  }
}
