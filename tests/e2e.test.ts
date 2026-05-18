import { createHash } from "node:crypto"
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"

import { afterEach, describe, expect, it } from "vitest"

import { createCallbackPayload } from "../src/callback.js"
import { buildPayloadSchema, callbackPayloadSchema, runnerManifestSchema, BuildPayload } from "../src/schema.js"
import { generateManifest, runBuild, validatePayload } from "../src/runner.js"
import branchPayload from "./fixtures/branch-payload.json" with { type: "json" }

const ciRepoRoot = fileURLToPath(new URL("..", import.meta.url))
const parentRepoRoot = path.resolve(ciRepoRoot, "..")
const fixtureProject = path.join(ciRepoRoot, "tests", "fixtures", "java-maven-project")
const evidenceDirectory = process.env.SISYPHUS_EVIDENCE_DIR ?? path.join(parentRepoRoot, ".sisyphus", "evidence")
const tempDirectories: string[] = []

async function createTempDirectory() {
  const directory = await mkdtemp(path.join(tmpdir(), "guizhan-ci-e2e-"))
  tempDirectories.push(directory)

  return directory
}

async function writePayload(directory: string, payload: BuildPayload) {
  const payloadPath = path.join(directory, "payload.json")

  await writeFile(payloadPath, `${JSON.stringify(payload, null, 2)}\n`)

  return payloadPath
}

async function writeEvidence(name: string, data: Record<string, unknown>) {
  await mkdir(evidenceDirectory, { recursive: true })
  await writeFile(path.join(evidenceDirectory, name), `${JSON.stringify(data, null, 2)}\n`)
}

afterEach(async () => {
  await Promise.all(tempDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })))
})

describe("cross-repo runner contract", () => {
  it("builds the Java/Maven fixture and emits API-compatible manifest and callback payloads", async () => {
    const directory = await createTempDirectory()
    const sourceDirectory = path.join(directory, "source")
    const outputDirectory = path.join(directory, "runner-output")
    const payload = buildPayloadSchema.parse({
      ...branchPayload,
      build_command: "node scripts/create-fixture-artifact.mjs",
    })
    const payloadPath = await writePayload(directory, payload)

    await cp(fixtureProject, sourceDirectory, { recursive: true })
    await validatePayload(JSON.stringify(payload), payloadPath)
    await runBuild(payloadPath, sourceDirectory)
    const metadata = await generateManifest(payloadPath, sourceDirectory, outputDirectory)
    const manifest = runnerManifestSchema.parse(
      JSON.parse(await readFile(path.join(outputDirectory, "manifest.json"), "utf8"))
    )
    const artifactPath = path.join(sourceDirectory, "target", "java-maven-fixture.jar")
    const artifactBytes = await readFile(artifactPath)
    const callbackPayload = createCallbackPayload(
      payload,
      {
        manifestArtifactName: metadata.manifestArtifactName,
        manifestArtifactId: 456789,
        artifactNames: metadata.artifactNames,
      },
      "success",
      undefined,
      {
        GITHUB_RUN_ID: "987654321",
        GITHUB_RUN_ATTEMPT: "2",
      }
    )

    expect(metadata.artifactPaths).toEqual([artifactPath])
    expect(metadata.artifactNames).toEqual([metadata.buildArtifactName])
    expect(metadata.manifestArtifactName).toContain(payload.idempotency_key)
    expect(metadata.buildArtifactName).toContain(payload.idempotency_key)
    expect(manifest.dependencies).toEqual([])
    expect(manifest.artifacts[0]).toMatchObject({
      name: "java-maven-fixture.jar",
      sha1: createHash("sha1").update(artifactBytes).digest("hex"),
      sha256: createHash("sha256").update(artifactBytes).digest("hex"),
      size: artifactBytes.byteLength,
    })
    expect(callbackPayloadSchema.parse(callbackPayload)).toMatchObject({
      run_id: payload.run_id,
      profile_id: payload.profile_id,
      project_id: payload.project_id,
      conclusion: "success",
      manifest_artifact_id: 456789,
      artifact_names: [metadata.buildArtifactName],
      workflow_run_id: 987654321,
      workflow_attempt: 2,
    })

    await writeEvidence("task-9-ci-e2e.json", {
      artifact: manifest.artifacts[0]?.name,
      artifact_size: manifest.artifacts[0]?.size,
      callback_workflow_run_id: callbackPayload.workflow_run_id,
      manifest_artifact_name: metadata.manifestArtifactName,
      build_artifact_name: metadata.buildArtifactName,
    })
  })
})
