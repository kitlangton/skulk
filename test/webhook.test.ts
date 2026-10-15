import { afterAll, expect, test } from "bun:test"
import { deliverViaWebhook, displayTarget, isWebhook } from "../src/webhook.ts"

let status = 200
const received: unknown[] = []
const server = Bun.serve({
  port: 0,
  async fetch(request) {
    received.push(await request.json())
    return new Response("", { status })
  },
})
afterAll(() => server.stop())

const delivery = (url: string) => ({ sessionID: url, messageID: "msg_1", text: "wake up", metadata: { watch: "w1" } })

test("only https URLs are webhooks", () => {
  expect(isWebhook("https://relay.example/hooks/abc")).toBe(true)
  expect(isWebhook("http://relay.example/hooks/abc")).toBe(false)
  expect(isWebhook("ses_abc123")).toBe(false)
})

test("output shows a webhook's origin, never its path", () => {
  expect(displayTarget("https://relay.example/hooks/abc/SECRET")).toBe("https://relay.example/…")
  expect(displayTarget("ses_abc123")).toBe("ses_abc123")
})

test("posts the wake as JSON", async () => {
  status = 200
  expect(await deliverViaWebhook(delivery(server.url.href))).toEqual({ ok: true })
  expect(received.at(-1)).toEqual({ id: "msg_1", text: "wake up", metadata: { watch: "w1" } })
})

test("a 404 is permanent, a 503 or 429 is retried", async () => {
  for (const [code, permanent] of [[404, true], [503, false], [429, false]] as const) {
    status = code
    const result = await deliverViaWebhook(delivery(server.url.href))
    expect(result).toMatchObject({ ok: false, permanent })
  }
})
