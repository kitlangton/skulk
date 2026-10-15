import { chmodSync, closeSync, existsSync, openSync, rmSync, unlinkSync, writeSync } from "node:fs"
import { join } from "node:path"
import { Engine, fileLogger, logPath } from "./engine.ts"
import { daemonPID, pidPath } from "./pid.ts"
import type { Store } from "./store.ts"
import { deliverViaWebhook, isWebhook } from "./webhook.ts"
import { allowExec, builtinDeps, deliverViaOpencode, messageID, runWatch } from "./system.ts"

/** Ask a running daemon to look at the store now (after create or cancel). */
export function nudge(root: string) {
  const pid = daemonPID(root)
  if (pid === undefined) return false
  try {
    process.kill(pid, "SIGUSR1")
    return true
  } catch {
    return false
  }
}

function acquireLock(root: string) {
  for (const attempt of [1, 2]) {
    try {
      const fd = openSync(pidPath(root), "wx", 0o600)
      writeSync(fd, String(process.pid))
      closeSync(fd)
      return true
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST" || attempt === 2) throw error
      if (daemonPID(root) !== undefined) return false
      unlinkSync(pidPath(root))
    }
  }
  return false
}

export { daemonPID, looksLikeDaemon, pidPath } from "./pid.ts"

const stamp = () => new Date().toISOString()

/** Ended watches and their logs are kept this long, then deleted. */
export const retentionMs = 30 * 24 * 3600_000

export function pruneEnded(store: Store, now = Date.now()) {
  const removed = store.prune(now - retentionMs)
  for (const id of removed) rmSync(logPath(store.root, id), { force: true })
  return removed.length
}

export interface Loop {
  /** Look at the store now (a new or cancelled watch, or a check that just finished). */
  readonly nudge: () => void
  readonly stop: () => void
  readonly done: Promise<void>
}

/**
 * Ticks the engine whenever the earliest watch is due. Ticks are not awaited, so a slow check never holds
 * up other watches; instead each settled check nudges the loop, because a watch that was in flight was
 * invisible to `nextWakeAt()` when the loop last chose how long to sleep.
 */
export function startLoop(
  engine: Engine,
  options: { readonly minDelayMs?: number; readonly maxDelayMs?: number; readonly minGapMs?: number } = {},
): Loop {
  const minDelay = options.minDelayMs ?? 1000
  const maxDelay = options.maxDelayMs ?? 30_000
  // Bounds how often nudges can tick, in case a check keeps failing instantly without being rescheduled.
  const minGap = options.minGapMs ?? 100
  let lastTick = 0
  let stopping = false
  let pending = false
  let wakeUp: (() => void) | undefined
  const nudge = () => {
    pending = true
    wakeUp?.()
  }
  const done = (async () => {
    while (!stopping) {
      const gap = Date.now() - lastTick
      if (gap < minGap) await Bun.sleep(minGap - gap)
      if (stopping) break
      lastTick = Date.now()
      pending = false
      void engine.tick().catch((error) => console.error(`${stamp()} tick failed: ${error}`))
      const next = engine.nextWakeAt()
      const delay = Math.max(minDelay, Math.min(maxDelay, next === undefined ? maxDelay : next - Date.now()))
      if (pending || stopping) continue
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, delay)
        wakeUp = () => {
          clearTimeout(timer)
          resolve()
        }
      })
      wakeUp = undefined
    }
  })()
  return {
    nudge,
    stop: () => {
      stopping = true
      wakeUp?.()
    },
    done,
  }
}

export async function runDaemon(store: Store) {
  const root = store.root
  if (!acquireLock(root)) {
    console.log(`${stamp()} skulk daemon already running (pid ${daemonPID(root)}); exiting`)
    return
  }
  // launchd creates its StandardOutPath before applying the plist's Umask.
  if (existsSync(join(root, "daemon.log"))) chmodSync(join(root, "daemon.log"), 0o600)
  const release = () => {
    if (daemonPID(root) === process.pid) unlinkSync(pidPath(root))
  }
  let loop: Loop | undefined
  const exec = allowExec()
  const engine = new Engine({
    store,
    now: Date.now,
    run: runWatch,
    deliver: (delivery) => (isWebhook(delivery.sessionID) ? deliverViaWebhook(delivery) : deliverViaOpencode(delivery)),
    newMessageID: messageID,
    log: fileLogger(root),
    builtin: builtinDeps(store),
    allowExec: exec,
    onSettle: () => loop?.nudge(),
  })
  process.on("SIGUSR1", () => loop?.nudge())
  let stopping = false
  for (const signal of ["SIGTERM", "SIGINT", "SIGHUP"] as const)
    process.on(signal, async () => {
      if (stopping) return
      stopping = true
      console.log(`${stamp()} skulk daemon stopping (${signal}); stopping running commands`)
      loop?.stop()
      // Commands are stopped, not finished: their watches stay active and run again after a restart.
      await engine.stop()
      release()
      process.exit(0)
    })
  process.on("exit", release)

  const open = store.open()
  console.log(`${stamp()} skulk daemon started (pid ${process.pid}, ${open.length} open watches, state ${root}${exec ? "" : ", commands disabled"})`)
  const prune = () => {
    try {
      const count = pruneEnded(store)
      if (count > 0) console.log(`${stamp()} pruned ${count} watches that ended over 30 days ago`)
    } catch (error) {
      console.error(`${stamp()} prune failed: ${error}`)
    }
  }
  prune()
  const pruner = setInterval(prune, 6 * 3600_000)
  loop = startLoop(engine)
  await loop.done
  clearInterval(pruner)
}
