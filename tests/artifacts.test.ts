import { createHash } from "node:crypto"
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"

import JSZip from "jszip"
import { afterEach, describe, expect, it, vi } from "vitest"

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

async function writeJar(filePath: string, files: Record<string, string>) {
  const jar = new JSZip()
  for (const [filename, content] of Object.entries(files)) jar.file(filename, content)
  await writeFile(filePath, await jar.generateAsync({ type: "nodebuffer" }))
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
    expect(manifest.minecraft_versions).toBeUndefined()
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

  it("uses primary JAR metadata and templates according to the fallback table", async () => {
    const directory = await createTempDirectory()
    const artifactPath = path.join(directory, "plugin.jar")
    const payload = buildPayloadSchema.parse({
      ...branchPayload,
      source_resolved_identifier: "v1.2.0",
      source_commit_message: "fix: metadata",
      channel_version_count: 4,
      version_template: "release-{channel_seq}-{jar_version}",
      name_template: "{identifier} {profile}",
      changelog_template: "{commit_message} {repo}",
    })
    await writeJar(artifactPath, { "plugin.yml": "name: Jar Plugin\nversion: 1.0.0\n" })

    const manifest = await createRunnerManifest(payload, [artifactPath])

    expect(manifest).toMatchObject({
      version: "release-5-1.0.0",
      name: "v1.2.0 default",
      changelog: "fix: metadata ybw0014/example-plugin",
    })
  })

  it("keeps legacy payloads on the complete legacy path despite JAR metadata", async () => {
    const directory = await createTempDirectory()
    const artifactPath = path.join(directory, "plugin.jar")
    const payload = buildPayloadSchema.parse(branchPayload)
    await writeJar(artifactPath, { "plugin.yml": "name: Jar Plugin\nversion: 1.0.0\n" })

    await expect(createRunnerManifest(payload, [artifactPath])).resolves.toMatchObject({
      version: "branch-main-abcdef1",
      name: "Auto Build main",
      changelog: `Built from ${payload.source_repo}@${payload.source_commit_sha}`,
    })
  })

  it("keeps manifests unchanged without a catalog and detects compatibility in both manifest paths", async () => {
    const directory = await createTempDirectory()
    const artifactPath = path.join(directory, "plugin.jar")
    await writeJar(artifactPath, { "fabric.mod.json": '{"depends":{"minecraft":"1.20.4"}}' })
    const legacy = await createRunnerManifest(buildPayloadSchema.parse(branchPayload), [artifactPath])
    expect(legacy).toMatchObject({ platforms: ["paper"] })
    expect(legacy.minecraft_versions).toBeUndefined()

    const enabledLegacy = await createRunnerManifest(
      buildPayloadSchema.parse({ ...branchPayload, canonical_minecraft_versions: ["1.20", "1.20.4"] }),
      [artifactPath]
    )
    const enabledCapable = await createRunnerManifest(
      buildPayloadSchema.parse({
        ...branchPayload,
        source_resolved_identifier: "main",
        canonical_minecraft_versions: ["1.20", "1.20.4"],
      }),
      [artifactPath]
    )
    expect(enabledLegacy).toMatchObject({ platforms: ["fabric"], minecraft_versions: ["1.20.4"] })
    expect(enabledCapable).toMatchObject({ platforms: ["fabric"], minecraft_versions: ["1.20.4"] })
  })

  it("warns and retains the fallback platform when enabled artifacts have no supported descriptor", async () => {
    const directory = await createTempDirectory()
    const artifactPath = path.join(directory, "library.jar")
    const warning = vi.spyOn(console, "warn").mockImplementation(() => undefined)
    await writeJar(artifactPath, { "META-INF/MANIFEST.MF": "Manifest-Version: 1.0\n" })

    const manifest = await createRunnerManifest(
      buildPayloadSchema.parse({ ...branchPayload, canonical_minecraft_versions: ["1.20", "1.20.4"] }),
      [artifactPath]
    )

    expect(manifest).toMatchObject({ platforms: ["paper"] })
    expect(manifest.minecraft_versions).toBeUndefined()
    expect(warning).toHaveBeenCalledWith("No supported Minecraft compatibility descriptor found in build artifacts")
  })

  it("warns when enabled descriptors declare no Minecraft version constraints", async () => {
    const directory = await createTempDirectory()
    const artifactPath = path.join(directory, "fabric.jar")
    const warning = vi.spyOn(console, "warn").mockImplementation(() => undefined)
    await writeJar(artifactPath, { "fabric.mod.json": "{}" })

    const manifest = await createRunnerManifest(
      buildPayloadSchema.parse({ ...branchPayload, canonical_minecraft_versions: ["1.20", "1.20.4"] }),
      [artifactPath]
    )

    expect(manifest).toMatchObject({ platforms: ["fabric"] })
    expect(manifest.minecraft_versions).toBeUndefined()
    expect(warning).toHaveBeenCalledWith(
      "Supported Minecraft compatibility descriptors declared no Minecraft version constraints"
    )
  })

  it("falls back to valid JAR metadata, resolved identifiers, and legacy changelog", async () => {
    const directory = await createTempDirectory()
    const artifactPath = path.join(directory, "plugin.jar")
    await writeJar(artifactPath, { "plugin.yml": "name: Jar Plugin\nversion: 1.0.0\n" })

    const manifest = await createRunnerManifest(
      buildPayloadSchema.parse({ ...branchPayload, source_resolved_identifier: "v1.2.0" }),
      [artifactPath]
    )

    expect(manifest).toMatchObject({
      version: "1.0.0",
      name: "1.0.0",
      changelog: `Built from ${branchPayload.source_repo}@${branchPayload.source_commit_sha}`,
    })
  })

  it("uses legacy fallbacks for invalid JAR metadata and rejects invalid rendered templates", async () => {
    const directory = await createTempDirectory()
    const artifactPath = path.join(directory, "plugin.jar")
    await writeJar(artifactPath, { "plugin.yml": "name: \nversion: invalid value\n" })
    const payload = buildPayloadSchema.parse({ ...branchPayload, source_resolved_identifier: "v1.2.0" })

    await expect(createRunnerManifest(payload, [artifactPath])).resolves.toMatchObject({
      version: "branch-main-abcdef1",
      name: "branch-main-abcdef1",
    })
    await expect(
      createRunnerManifest(buildPayloadSchema.parse({ ...payload, version_template: "{jar_version}" }), [artifactPath])
    ).rejects.toThrow("Rendered version template is invalid")
    await expect(
      createRunnerManifest(buildPayloadSchema.parse({ ...payload, name_template: "   " }), [artifactPath])
    ).rejects.toThrow("Rendered name template is invalid")
    await expect(
      createRunnerManifest(
        buildPayloadSchema.parse({
          ...payload,
          changelog_template: "{commit_message}x",
          source_commit_message: "x".repeat(10000),
        }),
        [artifactPath]
      )
    ).rejects.toThrow("Rendered changelog template is too long")
  })

  it("rejects control characters from rendered names", async () => {
    const directory = await createTempDirectory()
    const artifactPath = path.join(directory, "plugin.jar")
    const payload = buildPayloadSchema.parse({
      ...branchPayload,
      source_resolved_identifier: "main",
      source_commit_message: "line\nbreak",
    })
    await writeJar(artifactPath, { "plugin.yml": "name: Jar\nversion: 1.0.0\n" })

    await expect(
      createRunnerManifest({ ...payload, name_template: "{commit_message}" }, [artifactPath])
    ).rejects.toThrow("Rendered name template is invalid")
    await writeJar(artifactPath, { "plugin.yml": "name: Bad\u0007Name\nversion: 1.0.0\n" })
    await expect(createRunnerManifest(payload, [artifactPath])).resolves.toMatchObject({ name: "1.0.0" })
  })
})
