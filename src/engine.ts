import { appendFileSync } from "node:fs"
import { join } from "node:path"
import { checkBuiltin, type BuiltinDeps } from "./builtin.ts"
import { evaluate, outputTail, type Check, type RunResult } from "./condition.ts"
import { wakeText } from "./message.ts"
import { logDirectory, type Store } from "./store.ts"
import { clip } from "./text.ts"
import { isBuiltin, Limits, type Outcome, type Status, type Watch } from "./watch.ts"
import { displayTarget } from "./webhook.ts"

export type DeliveryResult = { readonly ok: true } | { readonly ok: false; readonly permanent: boolean; readonly error: string }

export interface Delivery {
  readonly sessionID: string
  readonly messageID: string
  readonly text: string
  readonly metadata: Record<string, string>
}

export interface EngineDeps {
  readonly store: Store
  readonly now: () => number
  /** Runs a watch's command. Aborting the signal must stop the command (its whole process group). */
  readonly run: (watch: Watch, signal?: AbortSignal) => Promise<RunResult>
  readonly deliver: (delivery: Delivery) => Promise<DeliveryResult>
  readonly newMessageID: (now: number) => string
  readonly log?: (watchID: string, line: string) => void
  /** Concurrent checks and deliveries, not counting blocking `exits` commands (default 8). */
  readonly maxConcurrent?: number
  /** Concurrent blocking `exits` commands (default: the open-watch limit, so they never starve checks). */
  readonly maxBlocking?: number
  /** Probes for built-in conditions and for releasing slot holds. */
  readonly builtin?: BuiltinDeps
  /** Called whenever one watch's work settles, so a scheduler can recompute its next wake-up. */
  readonly onSettle?: () => void
  /** Whether `skulk poll` and `skulk when exits` commands may run (default true; SKULK_ALLOW_EXEC=0 disables). */
  readonly allowExec?: boolean
  /** Whether a foreground waiter's process is still running. */
  readonly processAlive?: (pid: number) => boolean
}

interface Running {
  readonly controller: AbortController
  readonly blocking: boolean
  readonly done: Promise<void>
}

export function processAlive(pid: number) {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM"
  }
}

const isBlocking = (watch: Watch) => watch.status === "active" && watch.condition?.type === "exits"
const runsCommand = (watch: Watch) => watch.kind === "poll" && !isBuiltin(watch.condition)

const sweepIntervalMs = 60_000

export const logPath = (root: string, watchID: string) => join(logDirectory(root), `${watchID}.log`)

export function fileLogger(root: string) {
  return (watchID: string, line: string) =>
    appendFileSync(logPath(root, watchID), `${new Date().toISOString()} ${line}\n`, { mode: 0o600 })
}

const finalStatus: Record<Outcome, Status> = { met: "done", timer: "done", expired: "expired", failed: "failed" }

export function deliveryBackoff(attempt: number) {
  return Math.min(15_000 * 2 ** Math.max(0, attempt - 1), 10 * 60_000)
}

/**
 * Processes due watches. Every state transition is persisted before its side effect, and each wake is
 * posted with a message ID chosen once and stored. Re-posting the same ID is idempotent in OpenCode, so a
 * crash or restart between posting and recording delivery cannot produce a second wake.
 */
export class Engine {
  private readonly inFlight = new Map<string, Running>()
  private sweeping = false
  private lastSweepAt = 0

  constructor(private readonly deps: EngineDeps) {}

  private log(watchID: string, line: string) {
    this.deps.log?.(watchID, line)
  }

  /** Starts work for every due watch not already in progress, and resolves when that work finishes. */
  tick() {
    const now = this.deps.now()
    this.cancelOrphans(now)
    const open = this.deps.store.open()
    this.abortEnded(open)
    const due = open
      .filter((watch) => !this.inFlight.has(watch.id))
      .filter((watch) =>
        watch.status === "firing" ? (watch.nextDeliveryAt ?? 0) <= now : watch.dueAt <= now || watch.deadlineAt <= now,
      )
      .sort((a, b) => a.dueAt - b.dueAt)
    const running = [...this.inFlight.values()]
    const room = {
      blocking: (this.deps.maxBlocking ?? Limits.maxActive) - running.filter((entry) => entry.blocking).length,
      short: (this.deps.maxConcurrent ?? 8) - running.filter((entry) => !entry.blocking).length,
    }
    const started = due.filter((watch) => room[isBlocking(watch) ? "blocking" : "short"]-- > 0).map((watch) => this.start(watch))
    const sweep = this.deps.builtin && !this.sweeping && now - this.lastSweepAt >= sweepIntervalMs ? this.sweepHolds(now) : Promise.resolve()
    return Promise.all([sweep, ...started]).then(() => undefined)
  }

  private start(watch: Watch) {
    const controller = new AbortController()
    const done = (async () => {
      try {
        if (watch.status === "firing") await this.deliver(watch)
        else await this.process(watch, controller.signal)
      } catch (error) {
        this.log(watch.id, `internal error: ${clip(String(error))}`)
      } finally {
        this.inFlight.delete(watch.id)
        this.deps.onSettle?.()
      }
    })()
    this.inFlight.set(watch.id, { controller, blocking: isBlocking(watch), done })
    return done
  }

  /** Stops commands whose watch was cancelled (or otherwise ended) while they ran. */
  private abortEnded(open: readonly Watch[]) {
    const ids = new Set(open.map((watch) => watch.id))
    for (const [id, entry] of this.inFlight)
      if (!ids.has(id) && !entry.controller.signal.aborted) {
        this.log(id, "watch ended while its command ran; stopping the command")
        entry.controller.abort()
      }
  }

  /** Cancels foreground waits whose `skulk` process has gone, so they neither hold a queue place nor a slot. */
  private cancelOrphans(now: number) {
    const alive = this.deps.processAlive ?? processAlive
    for (const watch of this.deps.store.open()) {
      if (watch.ownerPID === undefined || watch.status !== "active" || alive(watch.ownerPID)) continue
      if (this.deps.store.update({ ...watch, status: "cancelled", endedAt: now }, "active"))
        this.log(watch.id, `cancelled: waiting process ${watch.ownerPID} exited`)
    }
  }

  /** Aborts all running commands and waits (up to `graceMs`) for their work to settle. */
  async stop(graceMs = 5_000) {
    const running = [...this.inFlight.values()]
    for (const entry of running) entry.controller.abort()
    let timer: ReturnType<typeof setTimeout> | undefined
    await Promise.race([
      Promise.all(running.map((entry) => entry.done)),
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, graceMs)
      }),
    ])
    clearTimeout(timer)
  }

  /**
   * Ends holds that expired, whose watch was cancelled, or whose session has gone idle after its grace
   * period. An idle session has finished the work the wake started, so its place goes to the next waiter.
   */
  async sweepHolds(now = this.deps.now()) {
    this.sweeping = true
    this.lastSweepAt = now
    try {
      for (const hold of this.deps.store.holds()) {
        const watch = this.deps.store.get(hold.watchID)
        const reason =
          hold.expiresAt <= now
            ? "expired"
            : !watch || watch.status === "cancelled" || watch.status === "undeliverable"
              ? `watch ${watch?.status ?? "removed"}`
              : watch.ownerPID !== undefined && !(this.deps.processAlive ?? processAlive)(watch.ownerPID)
                ? `waiting process ${watch.ownerPID} exited`
                : !watch.noDeliver && watch.deliveredAt !== undefined && now - watch.deliveredAt >= Limits.holdGraceMs &&
                  (await this.deps.builtin!.sessionState(hold.sessionID).catch(() => "busy" as const)) !== "busy"
                ? "session idle"
                : undefined
        if (reason && this.deps.store.release(hold.watchID)) this.log(hold.watchID, `released slot ${hold.slot}: ${reason}`)
      }
    } finally {
      this.sweeping = false
    }
  }

  /** When the daemon should look again, at the latest. */
  nextWakeAt() {
    const times = this.deps.store
      .open()
      .filter((watch) => !this.inFlight.has(watch.id))
      .map((watch) => (watch.status === "firing" ? (watch.nextDeliveryAt ?? 0) : Math.min(watch.dueAt, watch.deadlineAt)))
    if (this.deps.builtin && this.deps.store.holds().length > 0) times.push(this.lastSweepAt + sweepIntervalMs)
    return times.length === 0 ? undefined : Math.min(...times)
  }

  private async process(watch: Watch, signal?: AbortSignal) {
    if (watch.kind === "timer") return this.fire(watch, "timer")
    if (this.deps.now() >= watch.deadlineAt) return this.fire(watch, "expired")
    if (runsCommand(watch) && this.deps.allowExec === false) {
      const error = "this daemon does not run commands (SKULK_ALLOW_EXEC=0); use a built-in condition or a timer"
      this.log(watch.id, error)
      return this.fire({ ...watch, consecutiveFailures: 1, lastError: error }, "failed")
    }
    let check: Check
    let exitCode: number | undefined
    let heldSince: number | undefined
    let nextIntervalMs: number | undefined
    const condition = watch.condition!
    if (isBuiltin(condition)) {
      if (!this.deps.builtin) throw new Error("built-in conditions need probes")
      const restartAt = watch.slot ? this.deps.store.lastGrantAt(watch.slot) : undefined
      const result = await checkBuiltin(watch, condition, this.deps.builtin, this.deps.now(), restartAt)
      check = result.check
      heldSince = result.heldSince
      nextIntervalMs = result.nextIntervalMs
    } else {
      const start = this.deps.now()
      const bounded =
        condition.type === "exits"
          ? { ...watch, timeoutMs: Math.max(1, Math.min(watch.timeoutMs ?? watch.deadlineAt - start, watch.deadlineAt - start)) }
          : watch
      const result = await this.deps.run(bounded, signal)
      if (signal?.aborted) return this.log(watch.id, "command stopped (watch cancelled or daemon stopping); result discarded")
      if (condition.type === "exits" && result.timedOut && this.deps.now() >= watch.deadlineAt) {
        const latest = outputTail(result)
        return this.fire(latest ? { ...watch, lastValue: latest.slice(0, 4000) } : watch, "expired", watch.status)
      }
      check = evaluate(condition, result, watch.baseline)
      exitCode = result.exitCode ?? undefined
    }
    const now = this.deps.now()
    const next: Watch = { ...watch, checks: watch.checks + 1, lastCheckAt: now, lastExit: exitCode, heldSince }
    if (check.type === "met" && watch.slot) {
      const grant = this.deps.store.acquire(next, now)
      if (grant.ok) {
        next.holdExpiresAt = now + (watch.holdMs ?? Limits.defaultHoldMs)
        this.log(watch.id, `granted slot ${watch.slot} (${grant.held}/${grant.size})`)
      } else check = { type: "pending", value: `${check.value} · ${grant.reason}` }
    }
    if (check.type === "error") {
      next.consecutiveFailures = watch.consecutiveFailures + 1
      next.lastError = check.error
      if (check.value) next.lastValue = check.value.slice(0, 4000)
      this.log(watch.id, `check ${next.checks}: error (${next.consecutiveFailures}/${watch.maxFailures}): ${clip(check.error)}`)
      if (next.consecutiveFailures >= (watch.maxFailures ?? Limits.defaultMaxFailures)) return this.fire(next, "failed", watch.status)
    } else {
      next.consecutiveFailures = 0
      next.lastError = undefined
      next.previousValue = check.type === "met" ? (check.from ?? watch.lastValue) : watch.lastValue
      next.lastValue = check.value.slice(0, 4000)
      if (check.type === "pending" && check.baseline !== undefined) next.baseline = check.baseline
      const changed = watch.lastValue !== next.lastValue ? "" : " (unchanged)"
      this.log(watch.id, `check ${next.checks}: ${exitCode === undefined ? "" : `exit ${exitCode} `}value ${clip(check.value, 200)}${changed}${check.type === "met" ? " → condition met" : ""}`)
      if (check.type === "met") return this.fire(next, "met", watch.status)
    }
    // Coalesce: schedule from now, so a long sleep yields one catch-up check rather than a backlog.
    next.dueAt = now + (nextIntervalMs ?? watch.intervalMs ?? Limits.minIntervalMs)
    if (!this.deps.store.update(next, "active")) this.log(watch.id, "watch changed during check (cancelled?); result discarded")
  }

  private async fire(watch: Watch, outcome: Outcome, expected: Status = watch.status) {
    const now = this.deps.now()
    if (watch.noDeliver) {
      const done: Watch = {
        ...watch,
        status: finalStatus[outcome],
        outcome,
        firedAt: now,
        deliveredAt: now,
        endedAt: now,
        wakeText: wakeText(watch, outcome, now),
      }
      if (!this.deps.store.update(done, expected)) {
        if (watch.slot) this.deps.store.release(watch.id)
        return this.log(watch.id, "watch changed before firing; skipped")
      }
      this.log(watch.id, `${outcome}: resolved foreground wait (${done.status})`)
      return
    }
    const firing: Watch = {
      ...watch,
      status: "firing",
      outcome,
      firedAt: now,
      wakeMessageID: this.deps.newMessageID(now),
      wakeText: wakeText(watch, outcome, now),
      deliveryAttempts: 0,
      nextDeliveryAt: now,
    }
    if (!this.deps.store.update(firing, expected)) {
      if (watch.slot) this.deps.store.release(watch.id)
      return this.log(watch.id, "watch changed before firing; skipped")
    }
    this.log(watch.id, `${outcome}: queueing wake into ${displayTarget(watch.sessionID)} as ${firing.wakeMessageID}`)
    await this.deliver(firing)
  }

  private async deliver(watch: Watch) {
    const result = await this.deps.deliver({
      sessionID: watch.sessionID,
      messageID: watch.wakeMessageID!,
      text: watch.wakeText!,
      metadata: { source: "skulk", watchID: watch.id, outcome: watch.outcome ?? "" },
    })
    const now = this.deps.now()
    const attempts = watch.deliveryAttempts + 1
    let next: Watch
    if (result.ok) {
      next = { ...watch, status: finalStatus[watch.outcome!], deliveredAt: now, endedAt: now, deliveryAttempts: attempts, nextDeliveryAt: undefined }
      this.log(watch.id, `delivered to ${displayTarget(watch.sessionID)} (attempt ${attempts}); watch ${next.status}`)
    } else if (result.permanent || now - (watch.firedAt ?? now) >= Limits.deliveryWindowMs) {
      next = { ...watch, status: "undeliverable", endedAt: now, deliveryAttempts: attempts, lastDeliveryError: result.error }
      if (watch.slot && this.deps.store.release(watch.id)) this.log(watch.id, `released slot ${watch.slot}: undeliverable`)
      this.log(watch.id, `could not deliver, giving up: ${clip(result.error)}`)
    } else {
      next = { ...watch, deliveryAttempts: attempts, lastDeliveryError: result.error, nextDeliveryAt: now + deliveryBackoff(attempts) }
      this.log(watch.id, `delivery attempt ${attempts} failed, retrying in ${Math.round(deliveryBackoff(attempts) / 1000)}s: ${clip(result.error)}`)
    }
    if (!this.deps.store.update(next, "firing")) this.log(watch.id, "watch changed during delivery (cancelled?)")
  }
}
