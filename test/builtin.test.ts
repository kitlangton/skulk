import { describe, expect, test } from "bun:test"
import { isVersionNewer, parseCapacity } from "../src/builtin.ts"
import { exitsWatch, whenWatch } from "../src/create.ts"
import type { Builtin } from "../src/watch.ts"
import { capacityLine, Harness, ok, SESSION } from "./helpers.ts"

const minute = 60_000
const capacity = (stableMs = 3 * minute): Builtin => ({ type: "capacity", cpu: 70, builds: 1, diskGB: 20, stableMs })

function when(h: Harness, name: string, condition: Builtin, options: { slot?: string; holdMs?: number; sessionID?: string } = {}) {
  const watch = whenWatch({ id: `wk_${name}`, name, sessionID: options.sessionID ?? SESSION, instruction: `Run ${name}.`, now: h.now, condition, slot: options.slot, holdMs: options.holdMs })
  h.store.insert(watch)
  h.advance(1) // distinct creation order
  return watch
}

/** Advance a minute and run every due check. */
async function step(h: Harness, minutes = 1) {
  for (let index = 0; index < minutes; index++) {
    h.advance(minute)
    await h.tick()
  }
}

describe("capacity summary", () => {
  test("parses mac-sim-lease --status and JSON", () => {
    expect(parseCapacity(capacityLine(62, 1, 45))).toEqual({ cpu: 62, builds: 1, diskGB: 45 })
    expect(parseCapacity('{"cpu": 40, "builds": 2, "diskGB": 80}')).toEqual({ cpu: 40, builds: 2, diskGB: 80 })
    expect(parseCapacity('{"cpu": 35, "diskGB": 100}')).toEqual({ cpu: 35, builds: 0, diskGB: 100 })
  })

  test("a missing CPU sample is unknown, and other text is unreadable", () => {
    expect(parseCapacity(capacityLine("", 0, 45))).toEqual({ cpu: undefined, builds: 0, diskGB: 45 })
    expect(parseCapacity("hello")).toBeUndefined()
  })
})

describe("wake when capacity", () => {
  test("fires only after capacity holds steadily, and a spike restarts the window", async () => {
    const h = new Harness()
    const watch = when(h, "proofs", capacity())
    h.capacity = capacityLine(90, 0, 60)
    await step(h)
    h.capacity = capacityLine(60, 0, 60)
    await step(h, 2)
    h.capacity = capacityLine(85, 0, 60)
    await step(h)
    expect(h.get(watch.id).heldSince).toBeUndefined()
    h.capacity = capacityLine(60, 0, 60)
    await step(h, 3)
    expect(h.server.messages.size).toBe(0)
    await step(h)
    expect(h.server.messages.size).toBe(1)
    expect(h.server.texts[0]).toContain("Condition: until the Mac has capacity")
    expect(h.server.texts[0]).toContain("cpu 60% · 0 xcodebuild · 60 GB free")
  })

  test("builds and disk count as well as CPU", async () => {
    const h = new Harness()
    when(h, "proofs", capacity(0))
    h.capacity = capacityLine(10, 2, 60)
    await step(h)
    h.capacity = capacityLine(10, 0, 12)
    await step(h)
    expect(h.server.messages.size).toBe(0)
    h.capacity = capacityLine(10, 1, 60)
    await step(h)
    expect(h.server.messages.size).toBe(1)
  })

  test("an unreadable probe is a failed check, not capacity", async () => {
    const h = new Harness()
    const watch = when(h, "proofs", capacity(0))
    h.capacity = "mac-sim-lease: command not found"
    await step(h)
    expect(h.get(watch.id).consecutiveFailures).toBe(1)
    expect(h.server.messages.size).toBe(0)
  })
})

describe("slots", () => {
  test("waiters are granted in order, one place at a time", async () => {
    const h = new Harness()
    h.store.setSlotSize("heavy", 1)
    const first = when(h, "perf", capacity(0), { slot: "heavy" })
    const second = when(h, "arch", capacity(0), { slot: "heavy" })
    await step(h)
    expect([...h.server.messages.values()].map((message) => message.metadata.watchID)).toEqual([first.id])
    expect(h.server.texts[0]).toContain(`skulk release ${first.id}`)
    expect(h.get(second.id).lastValue).toContain("slot heavy full (1/1)")
    h.store.release(first.id)
    await step(h)
    expect(h.server.messages.size).toBe(2)
  })

  test("a newer waiter cannot jump the queue", async () => {
    const h = new Harness()
    const older = when(h, "older", { type: "idle", sessions: ["ses_busyOne"], stableMs: 0 }, { slot: "solo" })
    const newer = when(h, "newer", capacity(0), { slot: "solo" })
    await step(h)
    expect(h.server.messages.size).toBe(0)
    expect(h.get(newer.id).lastValue).toContain(`queued behind ${older.name}`)
  })

  test("each grant restarts the other waiters' steady window", async () => {
    const h = new Harness()
    const first = when(h, "first", capacity(3 * minute), { slot: "heavy" })
    const second = when(h, "second", capacity(3 * minute), { slot: "heavy" })
    await step(h, 4)
    const granted = (id: string) => [...h.server.messages.values()].some((message) => message.metadata.watchID === id)
    expect(granted(first.id)).toBe(true)
    expect(granted(second.id)).toBe(false)
    await step(h, 2)
    expect(granted(second.id)).toBe(false)
    await step(h, 2)
    expect(granted(second.id)).toBe(true)
  })

  test("a hold ends when the woken session goes idle after its grace period, or expires", async () => {
    const h = new Harness()
    h.store.setSlotSize("heavy", 1)
    const idleSession = "ses_worker1"
    const first = when(h, "first", capacity(0), { slot: "heavy", sessionID: idleSession })
    await step(h)
    expect(h.store.holds("heavy").map((hold) => hold.watchID)).toEqual([first.id])
    h.sessions.set(idleSession, "idle")
    await step(h)
    expect(h.store.holds("heavy")).toHaveLength(1) // still within the grace period
    await step(h, 2)
    expect(h.store.holds("heavy")).toHaveLength(0)

    const second = when(h, "second", capacity(0), { slot: "heavy", holdMs: 10 * minute })
    await step(h)
    expect(h.store.holds("heavy").map((hold) => hold.watchID)).toEqual([second.id])
    await step(h, 11)
    expect(h.store.holds("heavy")).toHaveLength(0)

    h.server.script = ["missing"]
    const third = when(h, "third", capacity(0), { slot: "heavy", sessionID: "ses_deleted1" })
    await step(h)
    expect(h.get(third.id).status).toBe("undeliverable")
    expect(h.store.holds("heavy")).toHaveLength(0)
  })
})

describe("wake when idle and done", () => {
  test("idle waits for every session to stay idle", async () => {
    const h = new Harness()
    when(h, "push", { type: "idle", sessions: ["ses_perf", "ses_arch"], stableMs: 2 * minute })
    h.sessions.set("ses_perf", "idle")
    await step(h, 3)
    expect(h.server.messages.size).toBe(0)
    h.sessions.set("ses_arch", "idle")
    await step(h, 2)
    expect(h.server.messages.size).toBe(0)
    await step(h)
    expect(h.server.messages.size).toBe(1)
    expect(h.server.texts[0]).toContain("ses_perf idle · ses_arch idle")
  })

  test("a missing session is a failed check", async () => {
    const h = new Harness()
    const watch = when(h, "push", { type: "idle", sessions: ["ses_gone"], stableMs: 0 })
    h.sessions.set("ses_gone", "missing")
    await step(h)
    expect(h.get(watch.id).lastError).toContain("not found")
  })

  test("done fires once every named watch has ended", async () => {
    const h = new Harness()
    const a = when(h, "a", capacity(0))
    const b = when(h, "b", { type: "idle", sessions: ["ses_never"], stableMs: 0 })
    const after = when(h, "after", { type: "done", watches: [a.id, b.id] })
    h.capacity = capacityLine(95, 0, 60)
    await step(h)
    h.store.update({ ...h.get(b.id), status: "cancelled" }, "active")
    h.capacity = capacityLine(10, 0, 60)
    await step(h)
    await step(h)
    const fired = [...h.server.messages.values()].map((message) => message.metadata.watchID)
    expect(fired).toContain(a.id)
    expect(fired).toContain(after.id)
  })
})

describe("wake when gh-run", () => {
  test("waits for a workflow run to appear, adapts interval from 10s to 15s, and wakes with conclusion, failed jobs and URL", async () => {
    const h = new Harness()
    const watch = when(h, "publish", {
      type: "gh-run",
      repo: "anomalyco/opencode",
      workflow: "publish.yml",
      sha: "41b03dea0f",
    })
    expect(watch.intervalMs).toBe(15_000)

    const url = "https://github.com/anomalyco/opencode/actions/runs/38036095840"
    h.probeResults = [
      // 1. Not created yet
      ok(JSON.stringify([])),
      // 2. Appeared and in_progress
      ok(
        JSON.stringify([
          {
            databaseId: 38036095840,
            headSha: "41b03dea0f1a35a09840800955d44c6b698c79dd",
            status: "in_progress",
            conclusion: "",
            url,
            workflowName: "publish",
          },
        ]),
      ),
      // 3. Completed in list -> triggers gh run view for jobs
      ok(
        JSON.stringify([
          {
            databaseId: 38036095840,
            headSha: "41b03dea0f1a35a09840800955d44c6b698c79dd",
            status: "completed",
            conclusion: "success",
            url,
            workflowName: "publish",
          },
        ]),
      ),
      ok(
        JSON.stringify({
          databaseId: 38036095840,
          headSha: "41b03dea0f1a35a09840800955d44c6b698c79dd",
          status: "completed",
          conclusion: "success",
          url,
          workflowName: "publish",
          jobs: [
            { name: "version", status: "completed", conclusion: "success" },
            { name: "publish", status: "completed", conclusion: "success" },
          ],
        }),
      ),
    ]

    await h.tick()
    expect(h.get(watch.id).lastValue).toContain("waiting for publish.yml run on 41b03dea0f")
    // Adaptive interval while waiting to appear is 10s
    expect(h.get(watch.id).dueAt).toBe(h.now + 10_000)

    h.advance(10_000)
    await h.tick()
    expect(h.get(watch.id).lastValue).toContain("in_progress · publish #38036095840")
    // Adaptive interval while in_progress is 15s
    expect(h.get(watch.id).dueAt).toBe(h.now + 15_000)
    expect(h.server.messages.size).toBe(0)

    h.advance(15_000)
    await h.tick()
    expect(h.server.messages.size).toBe(1)
    const text = h.server.texts[0]!
    expect(text).toContain("conclusion: success · failed jobs: none")
    expect(text).toContain(url)
    expect(h.get(watch.id).status).toBe("done")
  })

  test("watches a run by ID and reports failed job names when it fails", async () => {
    const h = new Harness()
    const url = "https://github.com/anomalyco/opencode/actions/runs/38012336134"
    when(h, "ci-run", { type: "gh-run", repo: "anomalyco/opencode", runID: "38012336134" })
    h.probeResults = [
      ok(
        JSON.stringify({
          databaseId: 38012336134,
          status: "in_progress",
          conclusion: "",
          url,
          workflowName: "test",
          jobs: [
            { name: "unit (linux)", status: "completed", conclusion: "failure" },
            { name: "e2e (linux)", status: "in_progress", conclusion: "" },
          ],
        }),
      ),
      ok(
        JSON.stringify({
          databaseId: 38012336134,
          status: "completed",
          conclusion: "failure",
          url,
          workflowName: "test",
          jobs: [
            { name: "unit (linux)", status: "completed", conclusion: "failure" },
            { name: "e2e (linux)", status: "completed", conclusion: "cancelled" },
            { name: "typecheck", status: "completed", conclusion: "success" },
          ],
        }),
      ),
    ]
    await h.tick()
    expect(h.server.messages.size).toBe(0)
    h.advance(15_000)
    await h.tick()
    expect(h.server.messages.size).toBe(1)
    expect(h.server.texts[0]).toContain("conclusion: failure · failed jobs: unit (linux), e2e (linux)")
    expect(h.server.texts[0]).toContain(url)
  })

  test("resolves a merged PR's mergeCommit SHA for workflow runs", async () => {
    const h = new Harness()
    const url = "https://github.com/anomalyco/opencode/actions/runs/38036095840"
    when(h, "pr-publish", { type: "gh-run", repo: "anomalyco/opencode", pr: 54198, workflow: "publish.yml" })
    h.probeResults = [
      ok(
        JSON.stringify({
          headRefOid: "a178639f3571ba817c7d34beee55528c4d0b82f0",
          mergeCommit: { oid: "41b03dea0f1a35a09840800955d44c6b698c79dd" },
          state: "MERGED",
        }),
      ),
      ok(
        JSON.stringify([
          {
            databaseId: 38036095840,
            headSha: "41b03dea0f1a35a09840800955d44c6b698c79dd",
            status: "completed",
            conclusion: "success",
            url,
            workflowName: "publish",
          },
        ]),
      ),
      ok(
        JSON.stringify({
          databaseId: 38036095840,
          headSha: "41b03dea0f1a35a09840800955d44c6b698c79dd",
          status: "completed",
          conclusion: "success",
          url,
          workflowName: "publish",
          jobs: [{ name: "publish", status: "completed", conclusion: "success" }],
        }),
      ),
    ]
    await h.tick()
    expect(h.server.messages.size).toBe(1)
    expect(h.server.texts[0]).toContain("conclusion: success · failed jobs: none")
    expect(h.server.texts[0]).toContain(url)
  })
})

describe("wake when pr-checks", () => {
  test("waits while checks are pending and wakes with pass/fail check lists when done", async () => {
    const h = new Harness()
    const watch = when(h, "pr-54275", { type: "pr-checks", repo: "anomalyco/opencode", pr: 54275, required: true })
    h.probeResults = [
      ok("no checks reported on the 'feature' branch", 1),
      ok(
        JSON.stringify([
          { name: "typecheck", bucket: "pass", state: "SUCCESS" },
          { name: "unit (linux)", bucket: "pending", state: "IN_PROGRESS" },
        ]),
        8,
      ),
      ok(
        JSON.stringify([
          { name: "typecheck", bucket: "pass", state: "SUCCESS" },
          { name: "unit (linux)", bucket: "fail", state: "FAILURE" },
        ]),
        1,
      ),
    ]
    await h.tick()
    expect(h.probes[0]).toContain("--required")
    expect(h.get(watch.id).lastValue).toContain("waiting for checks on PR #54275")

    h.advance(15_000)
    await h.tick()
    expect(h.get(watch.id).lastValue).toContain("pending (1/2): unit (linux) · 1 pass, 0 fail")
    expect(h.server.messages.size).toBe(0)

    h.advance(15_000)
    await h.tick()
    expect(h.server.messages.size).toBe(1)
    expect(h.server.texts[0]).toContain("fail (1 failed, 1 passed) · fail: unit (linux) · pass: typecheck")
  })
})

describe("wake when gl-pipeline", () => {
  test("waits for a pipeline to appear, tracks progress, and wakes with status, failed jobs and URL", async () => {
    const h = new Harness()
    const watch = when(h, "gl-main", { type: "gl-pipeline", repo: "acme/app", ref: "main" })
    expect(watch.intervalMs).toBe(15_000)
    const url = "https://gitlab.com/acme/app/-/pipelines/2944622344"
    h.probeResults = [
      // 1. Not created yet
      ok("[]"),
      // 2. Appeared in the list
      ok(JSON.stringify([{ id: 2944622344, status: "running", ref: "main", web_url: url }])),
      // 3. Detail with job progress
      ok(
        JSON.stringify({
          id: 2944622344,
          status: "running",
          ref: "main",
          web_url: url,
          jobs: [
            { name: "build", status: "success" },
            { name: "test", status: "running" },
          ],
        }),
      ),
      // 4. Finished in the list -> detail view
      ok(JSON.stringify([{ id: 2944622344, status: "failed", ref: "main", web_url: url }])),
      // 5. Detail: allow_failure and canceled jobs are not failed jobs
      ok(
        JSON.stringify({
          id: 2944622344,
          status: "failed",
          ref: "main",
          web_url: url,
          jobs: [
            { name: "build", status: "success" },
            { name: "test", status: "failed", allow_failure: false },
            { name: "lint", status: "failed", allow_failure: true },
            { name: "docs", status: "canceled" },
          ],
        }),
      ),
    ]

    await h.tick()
    expect(h.get(watch.id).lastValue).toContain("waiting for pipeline on main")
    // Adaptive interval while waiting to appear is 10s
    expect(h.get(watch.id).dueAt).toBe(h.now + 10_000)

    h.advance(10_000)
    await h.tick()
    expect(h.get(watch.id).lastValue).toContain("running (1/2 jobs) · main #2944622344")
    // Adaptive interval while running is 15s
    expect(h.get(watch.id).dueAt).toBe(h.now + 15_000)
    expect(h.server.messages.size).toBe(0)

    h.advance(15_000)
    await h.tick()
    expect(h.server.messages.size).toBe(1)
    expect(h.server.texts[0]).toContain("status: failed · failed jobs: test")
    expect(h.server.texts[0]).toContain(url)
    expect(h.get(watch.id).status).toBe("done")
  })

  test("watches a pipeline by ID and wakes when it succeeds", async () => {
    const h = new Harness()
    const url = "https://gitlab.com/acme/app/-/pipelines/2944622344"
    when(h, "gl-run", { type: "gl-pipeline", repo: "acme/app", pipelineID: "2944622344" })
    h.probeResults = [
      ok(
        JSON.stringify({
          id: 2944622344,
          status: "success",
          ref: "main",
          web_url: url,
          jobs: [{ name: "build", status: "success" }],
        }),
      ),
    ]
    await h.tick()
    expect(h.server.messages.size).toBe(1)
    expect(h.server.texts[0]).toContain("status: success · failed jobs: none")
    expect(h.server.texts[0]).toContain(url)
  })

  test("resolves the head pipeline of a merge request", async () => {
    const h = new Harness()
    const url = "https://gitlab.com/acme/app/-/pipelines/2944591528"
    const watch = when(h, "gl-mr", { type: "gl-pipeline", repo: "acme/app", mr: 42 })
    h.probeResults = [
      ok(
        JSON.stringify({
          id: 2944591528,
          status: "running",
          ref: "refs/merge-requests/42/train",
          web_url: url,
          jobs: [{ name: "test", status: "pending" }],
        }),
      ),
      ok(
        JSON.stringify({
          id: 2944591528,
          status: "canceled",
          ref: "refs/merge-requests/42/train",
          web_url: url,
          jobs: [{ name: "test", status: "canceled" }],
        }),
      ),
    ]
    await h.tick()
    expect(h.probes[0]).toContain("--merge-request")
    expect(h.get(watch.id).lastValue).toContain("running (0/1 jobs)")
    h.advance(15_000)
    await h.tick()
    expect(h.server.messages.size).toBe(1)
    expect(h.server.texts[0]).toContain("status: canceled · failed jobs: none")
    expect(h.get(watch.id).status).toBe("done")
  })

  test("a glab failure is a failed check, never a wake", async () => {
    const h = new Harness()
    const watch = when(h, "gl-fail", { type: "gl-pipeline", repo: "acme/app", ref: "main" })
    h.probeResults = [ok("error: no pipelines", 1)]
    await h.tick()
    expect(h.get(watch.id).consecutiveFailures).toBe(1)
    expect(h.server.messages.size).toBe(0)
  })
})

describe("wake when npm", () => {
  const npmPayload = (devVersion: string, devTime: string) =>
    JSON.stringify({
      "dist-tags": { latest: "2.0.26", dev: devVersion },
      time: {
        created: "2026-09-02T21:21:38.527Z",
        modified: devTime,
        "2.0.26": "2026-10-08T19:42:18.708Z",
        "0.0.0-dev-20800": "2026-10-10T00:20:09.487Z",
        ...(devVersion !== "0.0.0-dev-20800" ? { [devVersion]: devTime } : {}),
      },
      version: "2.0.26",
    })

  test("tag --changes records baseline and wakes with new version and publish time", async () => {
    const h = new Harness()
    const watch = when(h, "client-dev", { type: "npm", pkg: "@opencode/client", tag: "dev", mode: "changes" })
    h.probeResults = [
      ok(npmPayload("0.0.0-dev-20800", "2026-10-10T00:20:09.487Z")),
      ok(npmPayload("0.0.0-dev-20800", "2026-10-10T00:20:09.487Z")),
      ok(npmPayload("0.0.0-dev-20801", "2026-10-10T01:12:45.100Z")),
    ]
    await h.tick()
    expect(h.get(watch.id).baseline).toBe("0.0.0-dev-20800")
    expect(h.server.messages.size).toBe(0)

    h.advance(15_000)
    await h.tick()
    expect(h.server.messages.size).toBe(0)

    h.advance(15_000)
    await h.tick()
    expect(h.server.messages.size).toBe(1)
    expect(h.server.texts[0]).toContain("@opencode/client@0.0.0-dev-20800 (published 2026-10-10T00:20:09.487Z)` → `@opencode/client@0.0.0-dev-20801 (published 2026-10-10T01:12:45.100Z)")
  })

  test("--newer-than handles 0.0.0-dev-* prereleases using publish timestamps", async () => {
    const h = new Harness()
    when(h, "client-newer", { type: "npm", pkg: "@opencode/client", mode: "newer-than", newerThan: "0.0.0-dev-20800" })
    h.probeResults = [
      ok(npmPayload("0.0.0-dev-20800", "2026-10-10T00:20:09.487Z")),
      ok(npmPayload("0.0.0-dev-20801", "2026-10-10T01:12:45.100Z")),
    ]
    await h.tick()
    expect(h.server.messages.size).toBe(0)
    h.advance(15_000)
    await h.tick()
    expect(h.server.messages.size).toBe(1)
    expect(h.server.texts[0]).toContain("@opencode/client@0.0.0-dev-20801 (published 2026-10-10T01:12:45.100Z)")
  })

  test("--published-after wakes once a version is published after the target timestamp", async () => {
    const h = new Harness()
    when(h, "client-after", {
      type: "npm",
      pkg: "@opencode/client",
      tag: "dev",
      mode: "published-after",
      publishedAfter: Date.parse("2026-10-10T00:30:00Z"),
    })
    h.probeResults = [
      ok(npmPayload("0.0.0-dev-20800", "2026-10-10T00:20:09.487Z")),
      ok(npmPayload("0.0.0-dev-20801", "2026-10-10T01:12:45.100Z")),
    ]
    await h.tick()
    expect(h.server.messages.size).toBe(0)
    h.advance(15_000)
    await h.tick()
    expect(h.server.messages.size).toBe(1)
    expect(h.server.texts[0]).toContain("@opencode/client@0.0.0-dev-20801 (published 2026-10-10T01:12:45.100Z)")
  })

  test("isVersionNewer falls back to semver when timestamps are absent", () => {
    expect(isVersionNewer("2.0.27", "2.0.26", {})).toBe(true)
    expect(isVersionNewer("2.0.26", "2.0.26", {})).toBe(false)
    expect(isVersionNewer("2.0.25", "2.0.26", {})).toBe(false)
  })
})

describe("validation", () => {
  test("rejects bad slots, holds, sessions and event condition flags", () => {
    const base = { id: "wk_x", sessionID: SESSION, instruction: "x", now: 0 }
    expect(() => whenWatch({ ...base, condition: capacity(), slot: "bad slot" })).toThrow("--slot")
    expect(() => whenWatch({ ...base, condition: capacity(), holdMs: minute })).toThrow("--hold goes with --slot")
    expect(() => whenWatch({ ...base, condition: capacity(), slot: "heavy", holdMs: 13 * 3600_000 })).toThrow("--hold")
    expect(() => whenWatch({ ...base, condition: { type: "idle", sessions: ["nope"], stableMs: 0 } })).toThrow("not a session ID")
    expect(() => whenWatch({ ...base, condition: { type: "gh-run", repo: "bad", runID: "123" } })).toThrow("--repo")
    expect(() => whenWatch({ ...base, condition: { type: "gh-run", repo: "a/b" } })).toThrow("give one of")
    expect(() => whenWatch({ ...base, condition: { type: "gh-run", repo: "a/b", sha: "41b03dea0f" } })).toThrow("--workflow")
    expect(() => whenWatch({ ...base, condition: { type: "pr-checks", repo: "a/b", pr: 0 } })).toThrow("--pr")
    expect(() => whenWatch({ ...base, condition: { type: "gl-pipeline", repo: "acme" } })).toThrow("--repo")
    expect(() => whenWatch({ ...base, condition: { type: "gl-pipeline", repo: "acme/app" } })).toThrow("give one of")
    expect(() => whenWatch({ ...base, condition: { type: "gl-pipeline", repo: "acme/app", pipelineID: "abc" } })).toThrow("--pipeline must be a numeric")
    expect(() => whenWatch({ ...base, condition: { type: "gl-pipeline", repo: "acme/app", pipelineID: "1", ref: "main" } })).toThrow("takes no other target flags")
    expect(() => whenWatch({ ...base, condition: { type: "gl-pipeline", repo: "acme/app", mr: 0 } })).toThrow("--mr")
    expect(() => whenWatch({ ...base, condition: { type: "npm", pkg: "bad/pkg/name", mode: "changes" } })).toThrow("--package")
    expect(() => exitsWatch({ ...base, command: [] })).toThrow("blocking command")
  })
})
