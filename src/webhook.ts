import type { Delivery, DeliveryResult } from "./engine.ts"

/** A watch target that is an https URL is a webhook (e.g. a T3 Code scheduled task) instead of an OpenCode session. */
export const isWebhook = (target: string) => /^https:\/\/\S+$/.test(target)

/** A webhook URL usually carries its token in the path, so output and logs show only its origin. */
export const displayTarget = (target: string) => (isWebhook(target) ? `${URL.parse(target)?.origin ?? "https:/"}/…` : target)

/** POSTs the wake as JSON `{ id, text, metadata }`. A 4xx other than 408/429 is permanent. */
export async function deliverViaWebhook(delivery: Delivery): Promise<DeliveryResult> {
  try {
    const response = await fetch(delivery.sessionID, {
      method: "POST",
      headers: { "content-type": "application/json", "idempotency-key": delivery.messageID },
      body: JSON.stringify({ id: delivery.messageID, text: delivery.text, metadata: delivery.metadata }),
      signal: AbortSignal.timeout(60_000),
    })
    if (response.ok) return { ok: true }
    const status = response.status
    const permanent = status >= 400 && status < 500 && status !== 408 && status !== 429
    return { ok: false, permanent, error: `webhook HTTP ${status}: ${(await response.text()).slice(0, 300)}` }
  } catch (error) {
    return { ok: false, permanent: false, error: `webhook request failed: ${String(error)}` }
  }
}
