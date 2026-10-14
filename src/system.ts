import type { BuiltinDeps } from "./builtin.ts"
import type { RunResult } from "./condition.ts"
import type { Delivery, DeliveryResult } from "./engine.ts"
import type { Store } from "./store.ts"
import { env } from "./env.ts"
import { Limits, type Watch } from "./watch.ts"

const maxOutput = 64 * 1024

async function readCapped(stream: ReadableStream<Uint8Array>) {
  const decoder = new TextDecoder()
  let text = ""
  for await (const chunk of stream) {
    if (text.length < maxOutput) text += decoder.decode(chunk, { stream: true })
  }
  return text.slice(0, maxOutput)
}

export function defaultPath() {
  const home = process.env.HOME ?? ""
  return [`${home}/.bun/bin`, `${home}/.local/bin`, `${home}/bin`, "/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin", "/usr/sbin", "/sbin"].join(":")
}

/** Merge the watch's captured PATH with the launchd standard PATH so `gh`, `npm` and `bun` always resolve. */
export function daemonPath(watchPath?: string) {
  const entries = [...(watchPath ? watchPath.split(":") : []), ...(process.env.PATH ? process.env.PATH.split(":") : []), ...defaultPath().split(":")].filter(Boolean)
  return [...new Set(entries)].join(":")
}

/** After asking a stopped command to exit (SIGTERM), wait this long before SIGKILL. */
export const killGraceMs = 2_000

/**
 * Runs argv in its own process group, so a timeout or abort stops the whole pipeline. The command
 * inherits this process's environment, with PATH augmented by the watch's PATH and launchd standard
 * directories. A timeout kills at once; an abort sends SIGTERM, then SIGKILL after `killGraceMs`.
 */
export async function runCommand(
  argv: readonly string[],
  options: { readonly cwd?: string; readonly path?: string; readonly timeoutMs: number; readonly signal?: AbortSignal; readonly killGraceMs?: number },
): Promise<RunResult> {
  if (options.signal?.aborted) return { exitCode: null, stdout: "", stderr: "", timedOut: false, error: "aborted" }
  let child: ReturnType<typeof Bun.spawn<"ignore", "pipe", "pipe">>
  try {
    child = Bun.spawn([...argv], {
      cwd: options.cwd,
      env: { ...process.env, PATH: daemonPath(options.path) },
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
      detached: true,
    })
  } catch (error) {
    return { exitCode: null, stdout: "", stderr: "", timedOut: false, error: String(error) }
  }
  const kill = (signal: NodeJS.Signals) => {
    try {
      process.kill(-child.pid, signal)
    } catch {
      try {
        child.kill(signal)
      } catch {}
    }
  }
  let timedOut = false
  const timer = setTimeout(() => {
    timedOut = true
    kill("SIGKILL")
  }, options.timeoutMs)
  // Not cleared when the leader exits: group members that ignored SIGTERM still get SIGKILL.
  const onAbort = () => {
    kill("SIGTERM")
    setTimeout(() => kill("SIGKILL"), options.killGraceMs ?? killGraceMs).unref()
  }
  options.signal?.addEventListener("abort", onAbort, { once: true })
  const [stdout, stderr, exitCode] = await Promise.all([readCapped(child.stdout), readCapped(child.stderr), child.exited])
  clearTimeout(timer)
  options.signal?.removeEventListener("abort", onAbort)
  return { exitCode, stdout, stderr, timedOut }
}

export const runWatch = (watch: Watch, signal?: AbortSignal) =>
  runCommand(watch.command ?? [], {
    cwd: watch.cwd,
    path: watch.path,
    timeoutMs: watch.timeoutMs ?? Limits.defaultTimeoutMs,
    signal,
  })

/** `SKULK_ALLOW_EXEC=0` stops the daemon from running `skulk poll` / `skulk when exits` commands. */
export const allowExec = () => !["0", "false", "no"].includes((env("ALLOW_EXEC") ?? "").toLowerCase())

export const opencodeBinary = () => env("OPENCODE") ?? "opencode"

/** `opencode api` uses the same server discovery and credentials as the TUI. */
export async function opencodeApi(args: readonly string[], timeoutMs = 60_000) {
  return runCommand([opencodeBinary(), "api", ...args], { timeoutMs })
}

/** Queue a user message into a session via the shared OpenCode service. */
export async function deliverViaOpencode(delivery: Delivery): Promise<DeliveryResult> {
  const body = JSON.stringify({
    id: delivery.messageID,
    text: delivery.text,
    delivery: "queue",
    metadata: delivery.metadata,
  })
  const result = await opencodeApi(["post", `/api/session/${delivery.sessionID}/prompt`, "--data", body])
  if (result.exitCode === 0 && !result.timedOut) return { ok: true }
  const output = `${result.stdout} ${result.stderr}`.trim()
  const permanent = /SessionNotFoundError|HTTP 404|HTTP 400/.test(output)
  return { ok: false, permanent, error: result.error ?? (result.timedOut ? "opencode api timed out" : output.slice(0, 500)) }
}

export async function sessionExists(sessionID: string) {
  const result = await opencodeApi(["get", `/api/session/${sessionID}`], 30_000)
  if (result.exitCode === 0) {
    try {
      const title = (JSON.parse(result.stdout) as { data?: { title?: string } }).data?.title
      return { exists: true as const, title }
    } catch {
      return { exists: true as const, title: undefined }
    }
  }
  const output = `${result.stdout} ${result.stderr}`
  if (/SessionNotFoundError|HTTP 404/.test(output)) return { exists: false as const }
  throw new Error(`could not reach OpenCode to check the session: ${(result.error ?? output).trim().slice(0, 300)}`)
}

const chars = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz"

/** Same shape as OpenCode's ascending identifiers, so the wake sorts where it was created. */
export function messageID(now: number) {
  const value = BigInt(now) * 0x1000n + 1n
  const time = Array.from({ length: 6 }, (_, index) =>
    Number((value >> BigInt(40 - 8 * index)) & 0xffn)
      .toString(16)
      .padStart(2, "0"),
  ).join("")
  const bytes = crypto.getRandomValues(new Uint8Array(14))
  return `msg_${time}${Array.from(bytes, (byte) => chars[byte % 62]).join("")}`
}

export function watchID() {
  const bytes = crypto.getRandomValues(new Uint8Array(8))
  return `wk_${Array.from(bytes, (byte) => chars[byte % 62]).join("")}`
}

/** The capacity summary; `mac-sim-lease --status` owns the Mac's capacity signals. */
export const capacityCommand = () => env("CAPACITY_COMMAND") ?? "mac-sim-lease --status"

export const probeCapacity = (watch: Watch) =>
  runCommand(["/bin/sh", "-c", capacityCommand()], { path: watch.path, timeoutMs: 60_000 })

export const ghBinary = () => env("GH") ?? "gh"
export const glabBinary = () => env("GLAB") ?? "glab"
export const npmBinary = () => env("NPM") ?? "npm"
export const launchdLabel = () => env("LABEL") ?? "dev.kitlangton.skulk"

export const runProbe = (argv: readonly string[], watch: Watch) =>
  runCommand(argv, { cwd: watch.cwd, path: watch.path, timeoutMs: watch.timeoutMs ?? 60_000 })

export const builtinDeps = (store: Store): BuiltinDeps => ({
  capacity: probeCapacity,
  sessionState,
  watchStatus: (ref) => store.find(ref)?.status,
  exec: runProbe,
})

/**
 * A session is idle when its last idle time is at or after its last update: OpenCode stamps `time.idle`
 * when a run finishes and bumps `time.updated` while one is in progress.
 */
export async function sessionState(sessionID: string): Promise<"idle" | "busy" | "missing"> {
  const result = await opencodeApi(["get", `/api/session/${sessionID}`], 30_000)
  if (result.exitCode !== 0) {
    if (/SessionNotFoundError|HTTP 404/.test(`${result.stdout} ${result.stderr}`)) return "missing"
    throw new Error(`could not read session ${sessionID}: ${(result.error ?? result.stderr).trim().slice(0, 200)}`)
  }
  let time: { updated?: number; idle?: number } | undefined
  try {
    time = (JSON.parse(result.stdout) as { data?: { time?: { updated?: number; idle?: number } } }).data?.time
  } catch {
    throw new Error(`could not parse session ${sessionID} JSON from opencode api`)
  }
  return time?.idle !== undefined && time.idle >= (time.updated ?? 0) ? "idle" : "busy"
}
