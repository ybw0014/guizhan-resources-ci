import { createHash, createHmac } from "node:crypto"
import { execFile } from "node:child_process"
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { promisify } from "node:util"

import { afterEach, describe, expect, it } from "vitest"
import JSZip from "jszip"

import { createCallbackPayload } from "../src/callback.js"
import { buildPayloadSchema, callbackPayloadSchema, runnerManifestSchema, BuildPayload } from "../src/schema.js"
import { generateManifest, runBuild, stageBuildArtifacts, validatePayload } from "../src/runner.js"
import branchPayload from "./fixtures/branch-payload.json" with { type: "json" }

const ciRepoRoot = fileURLToPath(new URL("..", import.meta.url))
const parentRepoRoot = path.resolve(ciRepoRoot, "..")
const fixtureProject = path.join(ciRepoRoot, "tests", "fixtures", "java-maven-project")
const evidenceDirectory = process.env.SISYPHUS_EVIDENCE_DIR ?? path.join(parentRepoRoot, ".omo", "evidence")
const tempDirectories: string[] = []
const payloadSecret = "test-build-payload-secret"
const execFileAsync = promisify(execFile)

function signPayload(rawPayload: string, timestamp = "1700000000") {
  return {
    secret: payloadSecret,
    timestamp,
    signature: `sha256=${createHmac("sha256", payloadSecret).update(`${timestamp}.${rawPayload}`).digest("hex")}`,
  }
}

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
  it("compiles Java and builds a JAR with jar tooling before rewriting and validating it", async () => {
    const directory = await createTempDirectory()
    const source = path.join(directory, "source")
    await cp(fixtureProject, source, { recursive: true })
    await mkdir(path.join(source, "classes"), { recursive: true })
    await mkdir(path.join(source, "target"), { recursive: true })
    await execFileAsync("javac", [
      "-d",
      path.join(source, "classes"),
      path.join(source, "src", "main", "java", "io", "github", "guizhan", "resources", "fixture", "ExamplePlugin.java"),
    ])
    await writeFile(path.join(source, "classes", "plugin.yml"), "name: CompiledPlugin\nversion: 1.0\n")
    const payload = buildPayloadSchema.parse({
      ...branchPayload,
      source_resolved_identifier: "main",
      rewrite_version: true,
      name_template: "Compiled Beta",
      build_command: "jar --create --file target/compiled.jar -C classes .",
    })
    const payloadPath = await writePayload(directory, payload)
    await runBuild(payloadPath, source)
    const raw = path.join(directory, "raw")
    await stageBuildArtifacts(payloadPath, source, raw)
    const metadata = await generateManifest(
      payloadPath,
      raw,
      path.join(directory, "final"),
      path.join(directory, "output")
    )
    const finalJar = metadata.artifactPaths[0]!
    expect(path.basename(finalJar)).toBe("compiled-1.jar")
    await execFileAsync("jar", ["--validate", "--file", finalJar])
    const { stdout } = await execFileAsync("jar", ["tf", finalJar])
    expect(stdout).toContain("ExamplePlugin.class")
    expect(stdout).toContain("plugin.yml")
    const zip = await JSZip.loadAsync(await readFile(finalJar))
    expect(await zip.file("plugin.yml")!.async("string")).toContain("Compiled Beta")
  })

  it("builds in a subdirectory, stages, rewrites, and publishes the Maven fixture under its final name", async () => {
    const directory = await createTempDirectory()
    const source = path.join(directory, "source")
    const project = path.join(source, "modules", "plugin")
    const raw = path.join(directory, "raw")
    const final = path.join(directory, "final")
    const output = path.join(directory, "output")
    const payload = buildPayloadSchema.parse({
      ...branchPayload,
      build_directory: "modules/plugin",
      build_command: "node scripts/create-fixture-artifact.mjs",
      source_resolved_identifier: "main",
      rewrite_version: true,
      version_template: "build-{commit_sha}",
      name_template: "Display Beta",
      artifact_name_template: "Fixture-{version}",
    })
    const payloadPath = await writePayload(directory, payload)
    await cp(fixtureProject, project, { recursive: true })
    await runBuild(payloadPath, source)
    await stageBuildArtifacts(payloadPath, source, raw)
    const metadata = await generateManifest(payloadPath, raw, final, output)
    const manifest = runnerManifestSchema.parse(JSON.parse(await readFile(metadata.manifestPath, "utf8")))
    expect(manifest).toMatchObject({ version: "build-abcdef1", name: "Display Beta" })
    expect(manifest.artifacts[0]?.name).toBe("Fixture-build-abcdef1.jar")
    const bytes = await readFile(metadata.artifactPaths[0]!)
    expect(manifest.artifacts[0]).toMatchObject({
      sha1: createHash("sha1").update(bytes).digest("hex"),
      sha256: createHash("sha256").update(bytes).digest("hex"),
      size: bytes.length,
    })
    const jar = await JSZip.loadAsync(bytes)
    expect(await jar.file("plugin.yml")!.async("string")).toContain("Display Beta")
    await expect(execFileAsync("jar", ["--validate", "--file", metadata.artifactPaths[0]!])).resolves.toBeDefined()
    expect(await readFile(path.join(raw, "target", "java-maven-fixture.jar"))).toEqual(
      await readFile(path.join(project, "target", "java-maven-fixture.jar"))
    )
    expect(metadata.artifactNames).toEqual([metadata.buildArtifactName])
  })
  it("builds the Java/Maven fixture and emits API-compatible manifest and callback payloads", async () => {
    const directory = await createTempDirectory()
    const sourceDirectory = path.join(directory, "source")
    const outputDirectory = path.join(directory, "runner-output")
    const rawDirectory = path.join(directory, "artifact-source")
    const finalDirectory = path.join(directory, "artifact-final")
    const payload = buildPayloadSchema.parse({
      ...branchPayload,
      build_command: "node scripts/create-fixture-artifact.mjs",
    })
    const payloadPath = await writePayload(directory, payload)

    await cp(fixtureProject, sourceDirectory, { recursive: true })
    const rawPayload = JSON.stringify(payload)
    await validatePayload(rawPayload, payloadPath, signPayload(rawPayload))
    await runBuild(payloadPath, sourceDirectory)
    await stageBuildArtifacts(payloadPath, sourceDirectory, rawDirectory)
    const metadata = await generateManifest(payloadPath, rawDirectory, finalDirectory, outputDirectory)
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

    expect(metadata.artifactPaths).toEqual([path.join(finalDirectory, "target", "java-maven-fixture.jar")])
    expect(await readFile(path.join(rawDirectory, "target", "java-maven-fixture.jar"))).toEqual(artifactBytes)
    expect(await readFile(metadata.artifactPaths[0]!)).toEqual(artifactBytes)
    expect(metadata.artifactNames).toEqual([metadata.buildArtifactName])
    expect(metadata.manifestArtifactName).toContain(payload.idempotency_key)
    expect(metadata.buildArtifactName).toContain(payload.idempotency_key)
    expect(metadata.artifactNames).not.toContain(`${payload.idempotency_key}-build-artifacts-raw`)
    expect(manifest.dependencies).toEqual([])
    expect(manifest).toMatchObject({
      version: "branch-main-abcdef1",
      name: "Auto Build main",
      changelog: `Built from ${payload.source_repo}@${payload.source_commit_sha}`,
    })
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
