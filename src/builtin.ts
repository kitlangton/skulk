import type { Check, RunResult } from "./condition.ts"
import { ghBinary, glabBinary, npmBinary } from "./system.ts"
import { Limits, type Builtin, type Status, type Watch } from "./watch.ts"

export type SessionState = "idle" | "busy" | "missing"

export interface BuiltinDeps {
  /** Runs the capacity probe (`mac-sim-lease --status` by default). */
  readonly capacity: (watch: Watch) => Promise<RunResult>
  readonly sessionState: (sessionID: string) => Promise<SessionState>
  readonly watchStatus: (ref: string) => Status | undefined
  /** Runs an external CLI probe (`gh` or `npm`) at the command-runner boundary. */
  readonly exec?: (argv: readonly string[], watch: Watch) => Promise<RunResult>
}

export interface Capacity {
  readonly cpu: number | undefined
  readonly builds: number
  readonly diskGB: number
}

/** Reads the capacity summary from JSON (`{"cpu": 40, "builds": 0, "diskGB": 80}`) or `mac-sim-lease --status`. */
export function parseCapacity(text: string): Capacity | undefined {
  const trimmed = text.trim()
  if (trimmed.startsWith("{")) {
    try {
      const json = JSON.parse(trimmed) as { cpu?: number | null; builds?: number; diskGB?: number }
      if (typeof json.diskGB === "number") {
        return {
          cpu: typeof json.cpu === "number" ? json.cpu : undefined,
          builds: typeof json.builds === "number" ? json.builds : 0,
          diskGB: json.diskGB,
        }
      }
    } catch {}
  }
  const cpu = /cpu (\d+)% busy/.exec(text)
  const builds = /xcodebuild (\d+)/.exec(text)
  const disk = /disk (\d+) GB free/.exec(text)
  if (!builds || !disk || !/cpu \d*% busy/.test(text)) return undefined
  return { cpu: cpu ? Number(cpu[1]) : undefined, builds: Number(builds[1]), diskGB: Number(disk[1]) }
}

export const describeCapacity = (capacity: Capacity) =>
  `cpu ${capacity.cpu ?? "?"}% · ${capacity.builds} xcodebuild · ${capacity.diskGB} GB free`

export interface BuiltinCheck {
  readonly check: Check
  readonly heldSince?: number
  readonly nextIntervalMs?: number
}

interface GhRunSummary {
  readonly databaseId: number
  readonly headSha?: string
  readonly status: string
  readonly conclusion?: string
  readonly url: string
  readonly workflowName?: string
  readonly jobs?: readonly { readonly name: string; readonly status?: string; readonly conclusion?: string }[]
}

interface PrCheckItem {
  readonly name: string
  readonly state?: string
  readonly bucket: string
  readonly workflow?: string
  readonly link?: string
}

interface GlJob {
  readonly id?: number
  readonly name?: string
  readonly status?: string
  readonly allow_failure?: boolean
}

interface GlPipelineSummary {
  readonly id: number
  readonly status: string
  readonly ref?: string
  readonly sha?: string
  readonly source?: string
  readonly web_url: string
  readonly jobs?: readonly GlJob[]
}

interface NpmMetadata {
  readonly "dist-tags"?: Record<string, string>
  readonly time?: Record<string, string>
  readonly version?: string
}

const minutes = (ms: number) => `${Math.floor(ms / 60_000)}m`

function execError(label: string, result: RunResult) {
  if (result.error !== undefined) return result.error
  if (result.timedOut) return `${label} timed out`
  if (result.exitCode !== 0) {
    const detail = (result.stderr.trim() || result.stdout.trim()).split("\n").at(-1) ?? ""
    return `${label} exit ${result.exitCode}${detail ? `: ${detail}` : ""}`
  }
  return undefined
}

const adaptiveInterval = (watch: Watch, targetMs: number) =>
  watch.intervalMs === undefined || watch.intervalMs === Limits.eventIntervalMs ? targetMs : undefined

function formatRunDetail(detail: GhRunSummary, watch: Watch): BuiltinCheck {
  if (detail.status !== "completed") {
    const jobs = detail.jobs ?? []
    const done = jobs.filter((job) => job.status === "completed").length
    const progress = jobs.length > 0 ? ` (${done}/${jobs.length} jobs)` : ""
    const nextMs = detail.status === "in_progress" ? 15_000 : 10_000
    return {
      check: { type: "pending", value: `${detail.status}${progress} · ${detail.workflowName || "run"} #${detail.databaseId} · ${detail.url}` },
      nextIntervalMs: adaptiveInterval(watch, nextMs),
    }
  }
  const conclusion = detail.conclusion || "completed"
  const failedJobs = (detail.jobs ?? [])
    .filter((job) => job.conclusion && !["success", "skipped", "neutral"].includes(job.conclusion))
    .map((job) => job.name)
  const failedText = failedJobs.length > 0 ? failedJobs.join(", ") : "none"
  return { check: { type: "met", value: `conclusion: ${conclusion} · failed jobs: ${failedText} · ${detail.url}` } }
}

async function checkGhRun(watch: Watch, condition: Extract<Builtin, { readonly type: "gh-run" }>, exec: NonNullable<BuiltinDeps["exec"]>): Promise<BuiltinCheck> {
  const gh = ghBinary()
  const viewRun = async (runID: string | number): Promise<BuiltinCheck> => {
    const result = await exec([gh, "run", "view", String(runID), "-R", condition.repo, "--json", "databaseId,status,conclusion,url,workflowName,headSha,jobs"], watch)
    const err = execError("gh run view", result)
    if (err) return { check: { type: "error", error: err } }
    try {
      return formatRunDetail(JSON.parse(result.stdout) as GhRunSummary, watch)
    } catch {
      return { check: { type: "error", error: "could not parse gh run view JSON" } }
    }
  }

  if (condition.runID) return viewRun(condition.runID)

  let candidateShas: string[] = []
  if (condition.pr !== undefined) {
    const prResult = await exec([gh, "pr", "view", String(condition.pr), "-R", condition.repo, "--json", "headRefOid,mergeCommit,state"], watch)
    const err = execError("gh pr view", prResult)
    if (err) return { check: { type: "error", error: err } }
    try {
      const pr = JSON.parse(prResult.stdout) as { headRefOid?: string; mergeCommit?: { oid?: string } | null }
      candidateShas = [pr.mergeCommit?.oid, pr.headRefOid].filter((sha): sha is string => Boolean(sha))
    } catch {
      return { check: { type: "error", error: "could not parse gh pr view JSON" } }
    }
    if (candidateShas.length === 0) return { check: { type: "error", error: `no commit SHA found for PR #${condition.pr}` } }
  } else if (condition.sha) {
    candidateShas = [condition.sha]
  }

  const listArgs = [
    gh,
    "run",
    "list",
    "-R",
    condition.repo,
    ...(condition.workflow ? ["--workflow", condition.workflow] : []),
    ...(candidateShas.length === 1 && candidateShas[0]!.length === 40 ? ["--commit", candidateShas[0]!] : []),
    "--limit",
    "30",
    "--json",
    "databaseId,headSha,status,conclusion,url,workflowName",
  ]
  const listResult = await exec(listArgs, watch)
  const listErr = execError("gh run list", listResult)
  if (listErr) return { check: { type: "error", error: listErr } }
  let runs: GhRunSummary[]
  try {
    runs = JSON.parse(listResult.stdout) as GhRunSummary[]
  } catch {
    return { check: { type: "error", error: "could not parse gh run list JSON" } }
  }

  const matching =
    candidateShas
      .map((sha) => runs.filter((run) => run.headSha?.toLowerCase().startsWith(sha.toLowerCase())))
      .find((list) => list.length > 0) ?? []

  if (matching.length === 0) {
    const label = condition.pr !== undefined ? `PR #${condition.pr} (${candidateShas[0]!.slice(0, 10)})` : candidateShas[0]!.slice(0, 10)
    return {
      check: { type: "pending", value: `waiting for ${condition.workflow ?? "workflow"} run on ${label}` },
      nextIntervalMs: adaptiveInterval(watch, 10_000),
    }
  }

  const target = matching[0]!
  if (target.status !== "completed") {
    const nextMs = target.status === "in_progress" ? 15_000 : 10_000
    return {
      check: { type: "pending", value: `${target.status} · ${target.workflowName || condition.workflow || "run"} #${target.databaseId} · ${target.url}` },
      nextIntervalMs: adaptiveInterval(watch, nextMs),
    }
  }
  return viewRun(target.databaseId)
}

async function checkPrChecks(watch: Watch, condition: Extract<Builtin, { readonly type: "pr-checks" }>, exec: NonNullable<BuiltinDeps["exec"]>): Promise<BuiltinCheck> {
  const args = [
    ghBinary(),
    "pr",
    "checks",
    String(condition.pr),
    "-R",
    condition.repo,
    ...(condition.required ? ["--required"] : []),
    "--json",
    "name,state,bucket,workflow,link",
  ]
  const result = await exec(args, watch)
  if (result.error !== undefined) return { check: { type: "error", error: result.error } }
  if (result.timedOut) return { check: { type: "error", error: "gh pr checks timed out" } }
  const combined = `${result.stdout} ${result.stderr}`.trim()
  if (/no checks reported|no required checks/i.test(combined))
    return { check: { type: "pending", value: `waiting for checks on PR #${condition.pr}` } }
  if (!result.stdout.trim().startsWith("[")) {
    const err = execError("gh pr checks", result)
    return { check: { type: "error", error: err ?? "could not read gh pr checks output" } }
  }
  let checks: PrCheckItem[]
  try {
    checks = JSON.parse(result.stdout) as PrCheckItem[]
  } catch {
    return { check: { type: "error", error: "could not parse gh pr checks JSON" } }
  }
  if (checks.length === 0) return { check: { type: "pending", value: `waiting for checks on PR #${condition.pr}` } }
  const pending = checks.filter((item) => item.bucket === "pending")
  const failed = checks.filter((item) => item.bucket === "fail" || item.bucket === "cancel")
  const passed = checks.filter((item) => item.bucket === "pass" || item.bucket === "skipping")
  if (pending.length > 0)
    return {
      check: {
        type: "pending",
        value: `pending (${pending.length}/${checks.length}): ${pending.map((item) => item.name).join(", ")} · ${passed.length} pass, ${failed.length} fail`,
      },
    }
  const failNames = failed.map((item) => item.name).join(", ") || "none"
  const passNames = passed.map((item) => item.name).join(", ") || "none"
  const summary = failed.length > 0 ? `fail (${failed.length} failed, ${passed.length} passed)` : `pass (${passed.length}/${checks.length} passed)`
  return { check: { type: "met", value: `${summary} · fail: ${failNames} · pass: ${passNames}` } }
}

/** GitLab pipeline/job states that mean the run is over, one way or another. */
const glFinishedStatuses = new Set(["success", "failed", "canceled", "skipped"])
const glJobFinished = (status: string | undefined) => status !== undefined && glFinishedStatuses.has(status)

function formatGlPipeline(detail: GlPipelineSummary, watch: Watch): BuiltinCheck {
  if (!glFinishedStatuses.has(detail.status)) {
    const jobs = detail.jobs ?? []
    const done = jobs.filter((job) => glJobFinished(job.status)).length
    const progress = jobs.length > 0 ? ` (${done}/${jobs.length} jobs)` : ""
    const nextMs = detail.status === "running" ? 15_000 : 10_000
    return {
      check: { type: "pending", value: `${detail.status}${progress} · ${detail.ref || "pipeline"} #${detail.id} · ${detail.web_url}` },
      nextIntervalMs: adaptiveInterval(watch, nextMs),
    }
  }
  const failedJobs = (detail.jobs ?? [])
    .filter((job) => job.status === "failed" && !job.allow_failure)
    .map((job) => job.name ?? `job ${job.id ?? "?"}`)
  const failedText = failedJobs.length > 0 ? failedJobs.join(", ") : "none"
  return { check: { type: "met", value: `status: ${detail.status} · failed jobs: ${failedText} · ${detail.web_url}` } }
}

async function checkGlPipeline(watch: Watch, condition: Extract<Builtin, { readonly type: "gl-pipeline" }>, exec: NonNullable<BuiltinDeps["exec"]>): Promise<BuiltinCheck> {
  const glab = glabBinary()
  // --with-job-details pipeline JSON is far larger than skulk's 64KB output cap, so --jq
  // reduces it to the fields the check reads before it crosses the process boundary.
  const detailFields = "{id, status, ref, sha, web_url, jobs: [.jobs[]? | {id, name, status, allow_failure}]}"
  const viewPipeline = async (pipelineID: string | number): Promise<BuiltinCheck> => {
    const result = await exec([glab, "ci", "get", "-R", condition.repo, "-p", String(pipelineID), "--output", "json", "--with-job-details", "--jq", detailFields], watch)
    const err = execError("glab ci get", result)
    if (err) return { check: { type: "error", error: err } }
    try {
      return formatGlPipeline(JSON.parse(result.stdout) as GlPipelineSummary, watch)
    } catch {
      return { check: { type: "error", error: "could not parse glab ci get JSON" } }
    }
  }

  if (condition.pipelineID !== undefined) return viewPipeline(condition.pipelineID)

  if (condition.mr !== undefined) {
    // The head pipeline, not the latest pipeline on the source branch: forks and detached pipelines diverge.
    const result = await exec([glab, "ci", "get", "-R", condition.repo, "--merge-request", String(condition.mr), "--output", "json", "--with-job-details", "--jq", detailFields], watch)
    const err = execError("glab ci get", result)
    if (err) return { check: { type: "error", error: err } }
    try {
      return formatGlPipeline(JSON.parse(result.stdout) as GlPipelineSummary, watch)
    } catch {
      return { check: { type: "error", error: "could not parse glab ci get JSON" } }
    }
  }

  const listArgs = [
    glab,
    "ci",
    "list",
    "-R",
    condition.repo,
    ...(condition.ref ? ["--ref", condition.ref] : []),
    ...(condition.sha ? ["--sha", condition.sha] : []),
    "--per-page",
    "30",
    "--output",
    "json",
  ]
  const listResult = await exec(listArgs, watch)
  const listErr = execError("glab ci list", listResult)
  if (listErr) return { check: { type: "error", error: listErr } }
  let pipelines: GlPipelineSummary[]
  try {
    pipelines = JSON.parse(listResult.stdout) as GlPipelineSummary[]
  } catch {
    return { check: { type: "error", error: "could not parse glab ci list JSON" } }
  }
  if (!Array.isArray(pipelines)) return { check: { type: "error", error: "could not parse glab ci list JSON" } }
  // Newest first, matching gh-run's "most recent run wins".
  const target = pipelines.toSorted((a, b) => b.id - a.id)[0]
  if (!target) {
    const label = condition.sha !== undefined
      ? `${condition.ref ? `${condition.ref}@` : ""}${condition.sha.slice(0, 10)}`
      : (condition.ref ?? "the ref")
    return {
      check: { type: "pending", value: `waiting for pipeline on ${label}` },
      nextIntervalMs: adaptiveInterval(watch, 10_000),
    }
  }
  return viewPipeline(target.id)
}

export function isVersionNewer(candidate: string, baseline: string, timeMap: Record<string, string>) {  if (candidate === baseline) return false
  const candTime = timeMap[candidate] ? Date.parse(timeMap[candidate]!) : Number.NaN
  const baseTime = timeMap[baseline] ? Date.parse(timeMap[baseline]!) : Number.NaN
  if (!Number.isNaN(candTime) && !Number.isNaN(baseTime) && candTime !== baseTime) return candTime > baseTime
  try {
    return Bun.semver.order(candidate, baseline) > 0
  } catch {
    return candidate !== baseline
  }
}

function newestPublishedVersion(timeMap: Record<string, string>) {
  const entries = Object.entries(timeMap)
    .filter(([key]) => key !== "created" && key !== "modified" && key !== "unpublished")
    .map(([version, iso]) => ({ version, iso, ms: Date.parse(iso) }))
    .filter((entry) => !Number.isNaN(entry.ms))
    .sort((a, b) => b.ms - a.ms)
  return entries[0]
}

async function checkNpm(watch: Watch, condition: Extract<Builtin, { readonly type: "npm" }>, exec: NonNullable<BuiltinDeps["exec"]>): Promise<BuiltinCheck> {
  const result = await exec([npmBinary(), "view", condition.pkg, "dist-tags", "time", "version", "--json"], watch)
  const err = execError("npm view", result)
  if (err) return { check: { type: "error", error: err } }
  let data: NpmMetadata
  try {
    data = JSON.parse(result.stdout) as NpmMetadata
  } catch {
    return { check: { type: "error", error: "could not parse npm view JSON" } }
  }
  const distTags = data["dist-tags"] ?? {}
  const timeMap = data.time ?? {}
  const formatVer = (version: string) => `${condition.pkg}@${version} (published ${timeMap[version] ?? "unknown"})`
  const resolveTag = (tag: string): { version?: string; error?: BuiltinCheck } => {
    const version = distTags[tag]
    return version ? { version } : { error: { check: { type: "error", error: `dist-tag "${tag}" not found on ${condition.pkg}` } } }
  }

  if (condition.mode === "changes") {
    const { version: current, error } = resolveTag(condition.tag ?? "latest")
    if (error) return error
    const value = formatVer(current!)
    const from = condition.from ?? watch.baseline
    if (from === undefined) return { check: { type: "pending", value, baseline: current } }
    return current !== from ? { check: { type: "met", value, from: formatVer(from) } } : { check: { type: "pending", value } }
  }

  if (condition.mode === "newer-than") {
    const target = condition.newerThan!
    let candidate: string | undefined
    if (condition.tag) {
      const resolved = resolveTag(condition.tag)
      if (resolved.error) return resolved.error
      candidate = resolved.version
    } else if (timeMap[target]) {
      candidate = newestPublishedVersion(timeMap)?.version
    } else {
      candidate = distTags.latest ?? data.version ?? newestPublishedVersion(timeMap)?.version
    }
    if (!candidate) return { check: { type: "error", error: `no versions found for ${condition.pkg}` } }
    const value = formatVer(candidate)
    if (isVersionNewer(candidate, target, timeMap)) {
      const from = condition.tag || timeMap[target] ? formatVer(target) : `${condition.pkg}@${target}`
      return { check: { type: "met", value, from } }
    }
    return { check: { type: "pending", value: !condition.tag && timeMap[target] ? formatVer(target) : value } }
  }

  const afterMs = condition.publishedAfter!
  if (condition.tag) {
    const { version: current, error } = resolveTag(condition.tag)
    if (error) return error
    const publishedMs = timeMap[current!] ? Date.parse(timeMap[current!]!) : Number.NaN
    if (Number.isNaN(publishedMs)) return { check: { type: "error", error: `no publish time for ${condition.pkg}@${current}` } }
    const value = formatVer(current!)
    return publishedMs > afterMs ? { check: { type: "met", value } } : { check: { type: "pending", value } }
  }
  const newest = newestPublishedVersion(timeMap)
  if (!newest) return { check: { type: "error", error: `no publish timestamps found for ${condition.pkg}` } }
  const value = formatVer(newest.version)
  return newest.ms > afterMs ? { check: { type: "met", value } } : { check: { type: "pending", value } }
}

/**
 * A steady condition must hold continuously for `stableMs`. The window also restarts at the slot's last
 * grant, so a job started by one waiter is reflected in CPU before the next waiter can be granted.
 */
function steady(value: string, holds: boolean, stableMs: number, previous: number | undefined, now: number, restartAt = 0): BuiltinCheck {
  if (!holds) return { check: { type: "pending", value } }
  const since = previous ?? now
  const start = Math.max(since, restartAt)
  const held = now - start
  if (held >= stableMs) return { check: { type: "met", value }, heldSince: since }
  return { check: { type: "pending", value: `${value} · steady ${minutes(held)}/${minutes(stableMs)}` }, heldSince: since }
}

export async function checkBuiltin(watch: Watch, condition: Builtin, deps: BuiltinDeps, now: number, restartAt?: number): Promise<BuiltinCheck> {
  switch (condition.type) {
    case "capacity": {
      const result = await deps.capacity(watch)
      if (result.error !== undefined) return { check: { type: "error", error: result.error } }
      if (result.timedOut) return { check: { type: "error", error: "capacity probe timed out" } }
      if (result.exitCode !== 0) return { check: { type: "error", error: `capacity probe exit ${result.exitCode}: ${result.stderr.trim().split("\n").at(-1) ?? ""}` } }
      const capacity = parseCapacity(result.stdout)
      if (!capacity) return { check: { type: "error", error: "could not read the capacity summary" } }
      if (capacity.cpu === undefined) return { check: { type: "error", error: "no recent CPU reading", value: describeCapacity(capacity) } }
      const holds = capacity.cpu <= condition.cpu && capacity.builds <= condition.builds && capacity.diskGB >= condition.diskGB
      return steady(describeCapacity(capacity), holds, condition.stableMs, watch.heldSince, now, restartAt)
    }
    case "idle": {
      let states: (readonly [string, SessionState])[]
      try {
        states = await Promise.all(condition.sessions.map(async (session) => [session, await deps.sessionState(session)] as const))
      } catch (error) {
        return { check: { type: "error", error: (error as Error).message } }
      }
      const missing = states.find(([, state]) => state === "missing")
      if (missing) return { check: { type: "error", error: `session ${missing[0]} not found` } }
      const value = states.map(([session, state]) => `${session} ${state}`).join(" · ")
      return steady(value, states.every(([, state]) => state === "idle"), condition.stableMs, watch.heldSince, now)
    }
    case "done": {
      const states = condition.watches.map((ref) => [ref, deps.watchStatus(ref)] as const)
      const missing = states.find(([, status]) => status === undefined)
      if (missing) return { check: { type: "error", error: `no watch ${missing[0]}` } }
      const value = states.map(([ref, status]) => `${ref} ${status}`).join(" · ")
      const ended = states.every(([, status]) => status !== "active" && status !== "firing")
      return { check: ended ? { type: "met", value } : { type: "pending", value } }
    }
    case "gh-run": {
      if (!deps.exec) throw new Error("gh-run condition needs an exec probe")
      return checkGhRun(watch, condition, deps.exec)
    }
    case "pr-checks": {
      if (!deps.exec) throw new Error("pr-checks condition needs an exec probe")
      return checkPrChecks(watch, condition, deps.exec)
    }
    case "gl-pipeline": {
      if (!deps.exec) throw new Error("gl-pipeline condition needs an exec probe")
      return checkGlPipeline(watch, condition, deps.exec)
    }
    case "npm": {
      if (!deps.exec) throw new Error("npm condition needs an exec probe")
      return checkNpm(watch, condition, deps.exec)
    }
  }
}
