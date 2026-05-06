import { mkdir, readFile, writeFile } from "node:fs/promises"
import path from "node:path"

import { writeManifestAndMetadata, RunnerArtifactMetadata } from "./artifacts.js"
import { createCallbackPayload, sendCallback } from "./callback.js"
import { createCheckoutConfig, parseBuildPayload } from "./checkout.js"
import { executeBuildCommand } from "./command.js"
import { generateRunName } from "./names.js"
import { BuildPayload } from "./schema.js"
import { createToolchainConfig } from "./toolchain.js"

export function getArtifactRetentionDays(payload: BuildPayload): number {
  return Math.min(payload.artifact_retention, 7)
}

function outputLine(name: string, value: string): string {
  if (value.includes("\n")) {
    return `${name}<<EOF\n${value}\nEOF\n`
  }

  return `${name}=${value}\n`
}

async function appendGithubOutput(outputs: Record<string, string | number | undefined>) {
  const outputPath = process.env.GITHUB_OUTPUT

  if (!outputPath) {
    return
  }

  const content = Object.entries(outputs)
    .filter((entry): entry is [string, string | number] => entry[1] !== undefined)
    .map(([name, value]) => outputLine(name, String(value)))
    .join("")

  await writeFile(outputPath, content, { flag: "a" })
}

export async function validatePayload(rawPayload: string, payloadPath = "payload.json") {
  const payload = parseBuildPayload(rawPayload)
  const checkout = createCheckoutConfig(payload)
  const toolchain = createToolchainConfig(payload)

  await writeFile(payloadPath, `${JSON.stringify(payload, null, 2)}\n`)
  await appendGithubOutput({
    run_name: generateRunName(payload.idempotency_key, payload.run_id),
    run_id: payload.run_id,
    idempotency_key: payload.idempotency_key,
    source_repo: checkout.repository,
    source_commit_sha: checkout.ref,
    java_version: toolchain.javaVersion,
    maven_version: toolchain.mavenVersion,
    sdkman_custom: toolchain.sdkmanCustom ?? "",
    artifact_retention: getArtifactRetentionDays(payload),
  })

  return payload
}

export async function loadPayload(payloadPath: string): Promise<BuildPayload> {
  return parseBuildPayload(await readFile(payloadPath, "utf8"))
}

export async function runBuild(payloadPath: string, sourceDirectory: string): Promise<void> {
  const payload = await loadPayload(payloadPath)

  await executeBuildCommand(payload, sourceDirectory)
}

export async function generateManifest(payloadPath: string, sourceDirectory: string, outputDirectory: string) {
  const payload = await loadPayload(payloadPath)
  const metadata = await writeManifestAndMetadata(payload, sourceDirectory, outputDirectory)

  await appendGithubOutput({
    manifest_artifact_name: metadata.manifestArtifactName,
    build_artifact_name: metadata.buildArtifactName,
    manifest_path: metadata.manifestPath,
    artifact_paths: metadata.artifactPaths.join("\n"),
  })

  return metadata
}

async function readMetadata(outputDirectory: string): Promise<RunnerArtifactMetadata | undefined> {
  try {
    return JSON.parse(await readFile(path.join(outputDirectory, "artifact-metadata.json"), "utf8")) as RunnerArtifactMetadata
  } catch {
    return undefined
  }
}

function normalizeConclusion(value: string | undefined): "success" | "failure" | "cancelled" {
  if (value === "success" || value === "cancelled") {
    return value
  }

  return "failure"
}

export async function sendPostBuildCallback(payloadPath: string, outputDirectory: string): Promise<void> {
  const payload = await loadPayload(payloadPath)
  const metadata = await readMetadata(outputDirectory)
  const conclusion = normalizeConclusion(process.env.JOB_STATUS)
  const callbackPayload = createCallbackPayload(
    payload,
    {
      manifestArtifactName: metadata?.manifestArtifactName,
      artifactNames: metadata?.artifactNames,
    },
    conclusion,
    conclusion === "success" ? undefined : process.env.BUILD_ERROR_MESSAGE ?? "Build failed"
  )
  const secret = process.env.AUTO_BUILD_CALLBACK_SECRET

  if (!secret) {
    throw new Error("AUTO_BUILD_CALLBACK_SECRET is required for callback")
  }

  await sendCallback(payload, callbackPayload, secret)
}

async function main() {
  const [command, ...args] = process.argv.slice(2)

  if (command === "validate") {
    await validatePayload(process.env.BUILD_PAYLOAD ?? args[0] ?? "", args[1] ?? "payload.json")
    return
  }

  if (command === "build") {
    await runBuild(args[0] ?? "payload.json", args[1] ?? "source")
    return
  }

  if (command === "manifest") {
    const outputDirectory = args[2] ?? ".runner-output"
    await mkdir(outputDirectory, { recursive: true })
    await generateManifest(args[0] ?? "payload.json", args[1] ?? "source", outputDirectory)
    return
  }

  if (command === "callback") {
    await sendPostBuildCallback(args[0] ?? "payload.json", args[1] ?? ".runner-output")
    return
  }

  throw new Error(`Unknown runner command: ${command ?? "<missing>"}`)
}

if (import.meta.url === `file://${process.argv[1]}`) {
  await main()
}
