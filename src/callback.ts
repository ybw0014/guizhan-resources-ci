import { createHmac } from "node:crypto"

import { generateArtifactName } from "./names.js"
import { BuildPayload, CallbackPayload, callbackPayloadSchema } from "./schema.js"

export type CallbackMetadata = {
  manifestArtifactName?: string
  manifestArtifactId?: number
  artifactNames?: string[]
}

export function createCallbackPayload(
  payload: BuildPayload,
  metadata: CallbackMetadata,
  conclusion: CallbackPayload["conclusion"],
  errorMessage?: string,
  env: NodeJS.ProcessEnv = process.env
): CallbackPayload {
  const callbackPayload = {
    schema_version: 1,
    run_id: payload.run_id,
    config_id: payload.config_id,
    project_id: payload.project_id,
    idempotency_key: payload.idempotency_key,
    runner_repo: payload.runner_repo,
    runner_workflow: payload.runner_workflow,
    workflow_run_id: Number(env.GITHUB_RUN_ID ?? 1),
    workflow_attempt: Number(env.GITHUB_RUN_ATTEMPT ?? 1),
    conclusion,
    manifest_artifact_name: metadata.manifestArtifactName ?? generateArtifactName(payload.idempotency_key, "manifest"),
    manifest_artifact_id: metadata.manifestArtifactId,
    artifact_names: metadata.artifactNames ?? [],
    error_message: errorMessage,
  }

  return callbackPayloadSchema.parse(callbackPayload)
}

export function signCallbackBody(body: string, secret: string, timestamp: string): string {
  const digest = createHmac("sha256", secret).update(`${timestamp}.${body}`).digest("hex")

  return `sha256=${digest}`
}

export async function sendCallback(
  payload: BuildPayload,
  callbackPayload: CallbackPayload,
  secret: string,
  fetchImpl = globalThis.fetch
): Promise<void> {
  const body = JSON.stringify(callbackPayload)
  const timestamp = Math.floor(Date.now() / 1000).toString()
  const response = await fetchImpl(payload.callback_url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-guizhan-auto-build-timestamp": timestamp,
      "x-guizhan-auto-build-signature": signCallbackBody(body, secret, timestamp),
    },
    body,
  })

  if (!response.ok) {
    throw new Error(`Callback failed with HTTP ${response.status}`)
  }
}
