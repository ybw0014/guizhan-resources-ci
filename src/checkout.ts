import { buildPayloadSchema, BuildPayload } from "./schema.js"

export type CheckoutConfig = {
  repository: string
  ref: string
  path: string
}

export function parseBuildPayload(rawPayload: string): BuildPayload {
  const payload = JSON.parse(rawPayload) as unknown

  return buildPayloadSchema.parse(payload)
}

export function createCheckoutConfig(payload: BuildPayload, path = "source"): CheckoutConfig {
  return {
    repository: payload.source_repo,
    ref: payload.source_commit_sha,
    path,
  }
}
