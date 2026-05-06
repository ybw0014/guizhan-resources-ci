import { createHash } from "node:crypto"
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"

import { afterEach, describe, expect, it } from "vitest"

import { collectArtifactFiles, createRunnerManifest, hashArtifact, writeManifestAndMetadata } from "../src/artifacts.js"
import { generateArtifactName } from "../src/names.js"
import { buildPayloadSchema, runnerManifestSchema } from "../src/schema.js"
import branchPayload from "./fixtures/branch-payload.json" with { type: "json" }

const tempDirectories: string[] = []

async function createTempDirectory() {
  const directory = await mkdtemp(path.join(tmpdir(), "guizhan-ci-artifacts-"))
  tempDirectories.push(directory)

  return directory
}

afterEach(async () => {
  await Promise.all(tempDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })))
})

describe("artifact hashing", () => {
  it("computes SHA1, SHA256, and size for a build artifact", async () => {
    const directory = await createTempDirectory()
    const artifactPath = path.join(directory, "plugin.jar")
    const bytes = Buffer.from("fake jar bytes")

    await writeFile(artifactPath, bytes)

    const artifact = await hashArtifact(artifactPath)

    expect(artifact).toMatchObject({
      name: "plugin.jar",
      path: artifactPath,
      sha1: createHash("sha1").update(bytes).digest("hex"),
      sha256: createHash("sha256").update(bytes).digest("hex"),
      size: bytes.byteLength,
    })
  })

  it("collects jar and zip artifacts from default output paths", async () => {
    const directory = await createTempDirectory()
    const targetDirectory = path.join(directory, "target")
    const libsDirectory = path.join(directory, "build", "libs")

    await mkdir(targetDirectory, { recursive: true })
    await mkdir(libsDirectory, { recursive: true })
    await writeFile(path.join(targetDirectory, "plugin.jar"), "jar")
    await writeFile(path.join(libsDirectory, "plugin.zip"), "zip")
    await writeFile(path.join(targetDirectory, "ignored.txt"), "ignored")

    const artifacts = await collectArtifactFiles(directory)

    expect(artifacts.map((artifactPath) => path.basename(artifactPath)).sort()).toEqual(["plugin.jar", "plugin.zip"])
  })
})

describe("manifest generation", () => {
  it("generates manifest fields compatible with runnerManifestSchema", async () => {
    const directory = await createTempDirectory()
    const artifactPath = path.join(directory, "plugin.jar")
    const payload = buildPayloadSchema.parse(branchPayload)
    const bytes = Buffer.from("fake jar bytes")

    await writeFile(artifactPath, bytes)

    const manifest = await createRunnerManifest(payload, [artifactPath], "https://github.com/ybw0014/run/artifacts")

    expect(runnerManifestSchema.parse(manifest)).toEqual(manifest)
    expect(manifest).toMatchObject({
      run_id: payload.run_id,
      project_id: payload.project_id,
      channel: payload.channel,
      source_mode: payload.source_mode,
      source_identifier: payload.source_identifier,
      source_commit_sha: payload.source_commit_sha,
      build_profile: payload.build_profile,
    })
    expect(manifest.artifacts[0]).toMatchObject({
      name: "plugin.jar",
      url: "https://github.com/ybw0014/run/artifacts/plugin.jar",
      sha1: createHash("sha1").update(bytes).digest("hex"),
      sha256: createHash("sha256").update(bytes).digest("hex"),
      size: bytes.byteLength,
    })
  })

  it("writes manifest and artifact metadata with idempotency-key artifact names", async () => {
    const directory = await createTempDirectory()
    const sourceDirectory = path.join(directory, "source")
    const outputDirectory = path.join(directory, "output")
    const targetDirectory = path.join(sourceDirectory, "target")
    const payload = buildPayloadSchema.parse(branchPayload)

    await mkdir(targetDirectory, { recursive: true })
    await writeFile(path.join(targetDirectory, "plugin.jar"), "fake jar bytes")

    const metadata = await writeManifestAndMetadata(payload, sourceDirectory, outputDirectory)
    const manifest = runnerManifestSchema.parse(
      JSON.parse(await readFile(path.join(outputDirectory, "manifest.json"), "utf8"))
    )

    expect(metadata.manifestArtifactName).toBe(generateArtifactName(payload.idempotency_key, "manifest"))
    expect(metadata.buildArtifactName).toBe(generateArtifactName(payload.idempotency_key, "build-artifacts"))
    expect(metadata.manifestArtifactName).toContain(payload.idempotency_key)
    expect(metadata.buildArtifactName).toContain(payload.idempotency_key)
    expect(metadata.artifactNames).toEqual([metadata.buildArtifactName])
    expect(manifest.artifacts[0]?.name).toBe("plugin.jar")
  })
})
