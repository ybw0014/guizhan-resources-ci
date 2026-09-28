import { createHash } from "node:crypto"
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"

import JSZip from "jszip"
import { afterEach, describe, expect, it, vi } from "vitest"

import {
  collectArtifactFiles,
  createRunnerManifest,
  finalizeArtifacts,
  hashArtifact,
  writeManifestAndMetadata,
} from "../src/artifacts.js"
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

    expect(artifacts).toEqual([path.join(libsDirectory, "plugin.zip"), path.join(targetDirectory, "plugin.jar")])
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

  it("finalizes standardized raw output without applying build_directory twice and hashes final bytes", async () => {
    const directory = await createTempDirectory()
    const rawDirectory = path.join(directory, "raw")
    const finalDirectory = path.join(directory, "final")
    const outputDirectory = path.join(directory, "output")
    const rawArtifact = path.join(rawDirectory, "build", "libs", "plugin.zip")
    const bytes = Buffer.from("raw bytes unchanged")
    const payload = buildPayloadSchema.parse({
      ...branchPayload,
      build_directory: "projects/nested",
      rewrite_version: false,
    })
    await mkdir(path.dirname(rawArtifact), { recursive: true })
    await writeFile(rawArtifact, bytes)

    const metadata = await finalizeArtifacts(payload, rawDirectory, finalDirectory, outputDirectory)
    const finalArtifact = path.join(finalDirectory, "build", "libs", "plugin.zip")
    const manifest = runnerManifestSchema.parse(JSON.parse(await readFile(metadata.manifestPath, "utf8")))
    expect(metadata.artifactPaths).toEqual([finalArtifact])
    expect(await readFile(finalArtifact)).toEqual(bytes)
    expect(manifest.artifacts[0]).toMatchObject({
      name: "plugin.zip",
      size: bytes.length,
      sha1: createHash("sha1").update(bytes).digest("hex"),
      sha256: createHash("sha256").update(bytes).digest("hex"),
    })
    await writeFile(finalArtifact, "stale final")
    await finalizeArtifacts(payload, rawDirectory, finalDirectory, outputDirectory)
    expect(await readFile(finalArtifact)).toEqual(bytes)
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

  it("keeps manifests unchanged without detect_platforms and detects compatibility in both manifest paths", async () => {
    const directory = await createTempDirectory()
    const artifactPath = path.join(directory, "plugin.jar")
    await writeJar(artifactPath, { "fabric.mod.json": '{"depends":{"minecraft":"1.20.4"}}' })
    const legacy = await createRunnerManifest(buildPayloadSchema.parse(branchPayload), [artifactPath])
    expect(legacy).toMatchObject({ platforms: ["paper"] })
    expect(legacy.minecraft_versions).toBeUndefined()

    const enabledLegacy = await createRunnerManifest(
      buildPayloadSchema.parse({
        ...branchPayload,
        detect_platforms: true,
        canonical_minecraft_versions: ["1.20", "1.20.4"],
      }),
      [artifactPath]
    )
    const enabledCapable = await createRunnerManifest(
      buildPayloadSchema.parse({
        ...branchPayload,
        detect_platforms: true,
        source_resolved_identifier: "main",
        canonical_minecraft_versions: ["1.20", "1.20.4"],
      }),
      [artifactPath]
    )
    expect(enabledLegacy).toMatchObject({ platforms: ["fabric"], minecraft_versions: ["1.20.4"] })
    expect(enabledCapable).toMatchObject({ platforms: ["fabric"], minecraft_versions: ["1.20.4"] })
  })

  it("detects platforms without a catalog and omits Minecraft versions when detect_platforms is enabled", async () => {
    const directory = await createTempDirectory()
    const artifactPath = path.join(directory, "plugin.jar")
    await writeJar(artifactPath, { "fabric.mod.json": '{"depends":{"minecraft":">=1.20"}}' })

    const manifest = await createRunnerManifest(
      buildPayloadSchema.parse({ ...branchPayload, detect_platforms: true }),
      [artifactPath]
    )

    expect(manifest).toMatchObject({ platforms: ["fabric"] })
    expect(manifest.minecraft_versions).toBeUndefined()
  })

  it("fails detect_platforms when artifacts have no supported descriptor with or without a catalog", async () => {
    const directory = await createTempDirectory()
    const artifactPath = path.join(directory, "library.jar")
    await writeJar(artifactPath, { "META-INF/MANIFEST.MF": "Manifest-Version: 1.0\n" })

    for (const payload of [
      buildPayloadSchema.parse({ ...branchPayload, detect_platforms: true }),
      buildPayloadSchema.parse({
        ...branchPayload,
        source_resolved_identifier: "main",
        detect_platforms: true,
        canonical_minecraft_versions: ["1.20", "1.20.4"],
      }),
    ]) {
      await expect(createRunnerManifest(payload, [artifactPath])).rejects.toThrow(
        "detect_platforms is enabled but no supported descriptor was found in build artifacts"
      )
    }
  })

  it("warns and retains the fallback platform when detect_platforms is disabled or absent", async () => {
    const directory = await createTempDirectory()
    const artifactPath = path.join(directory, "library.jar")
    const warning = vi.spyOn(console, "warn").mockImplementation(() => undefined)
    await writeJar(artifactPath, { "META-INF/MANIFEST.MF": "Manifest-Version: 1.0\n" })

    for (const payload of [
      buildPayloadSchema.parse({ ...branchPayload, canonical_minecraft_versions: ["1.20", "1.20.4"] }),
      buildPayloadSchema.parse({
        ...branchPayload,
        detect_platforms: false,
        canonical_minecraft_versions: ["1.20", "1.20.4"],
      }),
    ]) {
      const manifest = await createRunnerManifest(payload, [artifactPath])
      expect(manifest).toMatchObject({ platforms: ["paper"] })
      expect(manifest.minecraft_versions).toBeUndefined()
    }
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

describe("rewrite-enabled artifact finalization", () => {
  async function setup(
    files: Record<string, Record<string, string> | string>,
    overrides: Record<string, unknown> = {}
  ) {
    const directory = await createTempDirectory()
    const raw = path.join(directory, "raw")
    for (const [name, content] of Object.entries(files)) {
      const destination = path.join(raw, "target", name)
      await mkdir(path.dirname(destination), { recursive: true })
      if (typeof content === "string") await writeFile(destination, content)
      else await writeJar(destination, content)
    }
    const payload = buildPayloadSchema.parse({
      ...branchPayload,
      source_resolved_identifier: "main",
      rewrite_version: true,
      version_template: "slug-{commit_sha}",
      name_template: "Display Name",
      ...overrides,
    })
    const final = path.join(directory, "final")
    const output = path.join(directory, "output")
    return { raw, final, output, payload, run: () => finalizeArtifacts(payload, raw, final, output) }
  }

  it("uses display name for every JAR, slug for filename, and final bytes for hashes", async () => {
    const setupResult = await setup({
      "Plugin.jar": { "plugin.yml": "version: 1.0\n", "META-INF/MANIFEST.MF": "Implementation-Version: 1.0\n" },
      "Plugin-sources.JAR": { "sources.txt": "source bytes" },
      "Plugin-javadoc.jar": { "javadoc.txt": "javadoc bytes" },
      "Plugin.zip": "zip bytes",
      "another.jar": { "fabric.mod.json": '{"version":"2.0"}' },
      "empty.jar": { "README.md": "no metadata" },
    })
    const result = await setupResult.run()
    const manifest = runnerManifestSchema.parse(JSON.parse(await readFile(result.manifestPath, "utf8")))
    expect(manifest).toMatchObject({ version: "slug-abcdef1", name: "Display Name" })
    expect(manifest.artifacts.map((artifact) => artifact.name)).toEqual(
      result.artifactPaths.map((file) => path.basename(file))
    )
    expect(manifest.artifacts.map((artifact) => artifact.name)).toContain("Plugin-slug-abcdef1.jar")
    expect(result.artifactPaths.map((file) => path.basename(file))).toContain("Plugin-sources-slug-abcdef1.JAR")
    for (const artifact of manifest.artifacts) {
      const bytes = await readFile(result.artifactPaths.find((file) => path.basename(file) === artifact.name)!)
      expect(artifact).toMatchObject({
        sha1: createHash("sha1").update(bytes).digest("hex"),
        sha256: createHash("sha256").update(bytes).digest("hex"),
        size: bytes.length,
      })
    }
    const jar = await JSZip.loadAsync(
      await readFile(result.artifactPaths.find((file) => path.basename(file) === "Plugin-slug-abcdef1.jar")!)
    )
    expect(await jar.file("plugin.yml")!.async("string")).toContain("Display Name")
    expect(await jar.file("META-INF/MANIFEST.MF")!.async("string")).toBe("Implementation-Version: 1.0\n")
    for (const name of ["Plugin-sources.JAR", "Plugin-javadoc.jar", "Plugin.zip", "empty.jar"]) {
      const finalName = `${name.slice(0, name.lastIndexOf("."))}-slug-abcdef1${name.slice(name.lastIndexOf("."))}`
      expect(await readFile(path.join(setupResult.final, "target", finalName))).toEqual(
        await readFile(path.join(setupResult.raw, "target", name))
      )
    }
    const repeat = await setupResult.run()
    expect(repeat.artifactPaths).toEqual(result.artifactPaths)
  })

  it("uses original per-artifact versions and one channel sequence without rerendering", async () => {
    const source = await setup(
      {
        "one.jar": { "plugin.yml": "version: '1.0'" },
        "two.jar": { "plugin.yml": "version: '2.0'" },
        "three.zip": "zip bytes",
      },
      { artifact_name_template: "{basename}-{jar_version}-{channel_seq}", channel_version_count: 2 }
    )
    const result = await source.run()
    expect(result.artifactPaths.map((file) => path.basename(file))).toEqual([
      "one-1.0-3.jar",
      "three--3.zip",
      "two-2.0-3.jar",
    ])
    await expect(
      setup({ "one.jar": { "plugin.yml": "version: 1" } }, { artifact_name_template: "{channel_seq}" }).then(
        (caseResult) => caseResult.run()
      )
    ).rejects.toThrow("channel")
  })

  it("uses the full MANIFEST version fallback per artifact without rewriting a manifest-only JAR", async () => {
    const source = await setup(
      {
        "library.jar": { "META-INF/MANIFEST.MF": "Implementation-Version: 2.0\n" },
        "plugin.jar": { "plugin.yml": "version: '1.0'" },
      },
      { artifact_name_template: "{basename}-{jar_version}-{channel_seq}", channel_version_count: 2 }
    )
    const result = await source.run()
    expect(result.artifactPaths.map((file) => path.basename(file))).toEqual(["library-2.0-3.jar", "plugin-1.0-3.jar"])
    expect(await readFile(result.artifactPaths[0]!)).toEqual(
      await readFile(path.join(source.raw, "target", "library.jar"))
    )
  })

  it("rewrites all JARs to the primary metadata name while filenames use their own old versions", async () => {
    const source = await setup(
      { "a.jar": { "plugin.yml": "version: '1.0'" }, "z.jar": { "fabric.mod.json": '{"version":"2.0"}' } },
      { name_template: "Display-{jar_version}", artifact_name_template: "{basename}-{jar_version}-{commit_sha}" }
    )
    const result = await source.run()
    const manifest = runnerManifestSchema.parse(JSON.parse(await readFile(result.manifestPath, "utf8")))
    expect(manifest.name).toBe("Display-1.0")
    expect(manifest.artifacts.map((artifact) => artifact.name)).toEqual(["a-1.0-abcdef1.jar", "z-2.0-abcdef1.jar"])
    for (const [file, descriptor] of [
      [result.artifactPaths[0]!, "plugin.yml"],
      [result.artifactPaths[1]!, "fabric.mod.json"],
    ] as const) {
      const jar = await JSZip.loadAsync(await readFile(file))
      expect(await jar.file(descriptor)!.async("string")).toContain("Display-1.0")
    }
  })

  it("freezes primary JAR, order, and compatibility before renaming reverses lexical order", async () => {
    const source = await setup(
      {
        "a-first.jar": { "plugin.yml": "version: 'Zed'\napi-version: '1.20'\n" },
        "z-second.jar": { "fabric.mod.json": '{"version":"Aye","depends":{"minecraft":"=1.21.1"}}' },
      },
      {
        name_template: "{jar_version}",
        artifact_name_template: "{jar_version}-{version}",
        detect_platforms: true,
        canonical_minecraft_versions: ["1.20.4", "1.21.1"],
      }
    )
    const result = await source.run()
    const manifest = runnerManifestSchema.parse(JSON.parse(await readFile(result.manifestPath, "utf8")))
    expect(manifest.name).toBe("Zed")
    expect(manifest.artifacts.map((artifact) => artifact.name)).toEqual([
      "Zed-slug-abcdef1.jar",
      "Aye-slug-abcdef1.jar",
    ])
    expect(manifest.platforms).toEqual(["spigot", "fabric"])
    expect(manifest.minecraft_versions).toEqual(["1.20.4", "1.21.1"])
  })

  it("does not count metadata inside a nested JAR as a rewriteable outer descriptor", async () => {
    const source = await setup({ "outer.jar": { "README.md": "outer" } })
    const nested = new JSZip()
    nested.file("plugin.yml", "version: inner")
    const outer = new JSZip()
    outer.file("lib/inner.jar", await nested.generateAsync({ type: "nodebuffer" }))
    await writeFile(path.join(source.raw, "target", "outer.jar"), await outer.generateAsync({ type: "nodebuffer" }))
    await expect(source.run()).rejects.toThrow("at least one JAR")
  })

  it("accepts commit SHA as the only filename run identifier", async () => {
    const source = await setup(
      { "one.jar": { "plugin.yml": "version: old" } },
      {
        artifact_name_template: "{commit_sha}",
      }
    )
    expect(path.basename((await source.run()).artifactPaths[0]!)).toBe("abcdef1.jar")
  })

  it.each(["Beta+1", "新版本", "line\nbreak"])("rejects unsafe expanded filename value %s", async (message) => {
    const source = await setup(
      { "one.jar": { "plugin.yml": "version: old" } },
      {
        artifact_name_template: "{commit_message}-{version}",
        source_commit_message: message,
      }
    )
    await expect(source.run()).rejects.toThrow("invalid final artifact name")
  })

  it("accepts an overlong raw filename when its final name is legal", async () => {
    const source = await setup(
      { [`${"a".repeat(125)}.jar`]: { "plugin.yml": "version: old" } },
      {
        artifact_name_template: "valid-{version}",
      }
    )
    const result = await source.run()
    expect(path.basename(result.artifactPaths[0]!)).toBe("valid-slug-abcdef1.jar")
    expect(JSON.parse(await readFile(result.manifestPath, "utf8")).artifacts[0].name).toBe("valid-slug-abcdef1.jar")
  })

  it.each([
    ["{basename}", "run identifier"],
    ["{jar_version}", "run identifier"],
    ["{git_branch}-{version}", "Unknown template variable"],
    ["{unknown}-{version}", "Unknown template variable"],
    ["{version}{ext}", "Unknown template variable: {ext}"],
    ["{version}-{}-", "Invalid artifact filename template"],
    ["{version}-{basename", "Invalid artifact filename template"],
    ["{version}-{{basename}}", "Invalid artifact filename template"],
    ["{version}+", "Invalid artifact filename template"],
  ])("rejects invalid filename template %s at payload validation", (template, message) => {
    const result = buildPayloadSchema.safeParse({ ...branchPayload, artifact_name_template: template })
    expect(result.error?.issues.some((issue) => issue.message.includes(message))).toBe(true)
  })

  it.each([
    ["CON.{version}", "invalid final artifact name"],
    ["{repo}-{version}", "invalid final artifact name"],
    ["{commit_message}-{version}", "invalid final artifact name"],
    ["{version}..jar", "invalid final artifact name"],
  ])("rejects unsafe expanded filename %s", async (template, message) => {
    const source = await setup(
      { "one.jar": { "plugin.yml": "version: 1" } },
      { artifact_name_template: template, source_commit_message: "bad value" }
    )
    await expect(source.run()).rejects.toThrow(message)
  })

  it("rejects missing metadata, collisions, and expansion beyond 128 before publishing", async () => {
    const noMetadata = await setup({ "none.jar": { "README.md": "empty" } })
    await expect(noMetadata.run()).rejects.toThrow("at least one JAR")
    const collision = await setup(
      { "one.jar": { "plugin.yml": "version: 1" }, "two.jar": { "plugin.yml": "version: 2" } },
      { artifact_name_template: "constant-{version}" }
    )
    await expect(collision.run()).rejects.toThrow("Duplicate final")
    const folded = await setup(
      { "one.jar": { "plugin.yml": "version: 'UPPER'" }, "two.jar": { "plugin.yml": "version: 'upper'" } },
      { artifact_name_template: "{jar_version}-{version}" }
    )
    await expect(folded.run()).rejects.toThrow("Duplicate final")
    const overflow = await setup(
      { "one.jar": { "plugin.yml": "version: 1" } },
      { artifact_name_template: `${"a".repeat(120)}-{version}` }
    )
    await expect(overflow.run()).rejects.toThrow("invalid final artifact name")
    await expect(readFile(path.join(overflow.output, "manifest.json"))).rejects.toThrow()
  })

  it("fails atomically on signed and malformed JARs and leaves raw files untouched", async () => {
    for (const second of [
      { "plugin.yml": "name: missing" },
      { "plugin.yml": "version: 2", "META-INF/PLUGIN.SF": "signature" },
    ] as Record<string, string>[]) {
      const source = await setup({ "one.jar": { "plugin.yml": "version: 1" }, "two.jar": second })
      const original = await readFile(path.join(source.raw, "target", "one.jar"))
      await expect(source.run()).rejects.toThrow("two.jar")
      expect(await readFile(path.join(source.raw, "target", "one.jar"))).toEqual(original)
      await expect(readFile(path.join(source.output, "manifest.json"))).rejects.toThrow()
    }
    const signedNonRewriteable = await setup({
      "one.jar": { "plugin.yml": "version: 1" },
      "other.jar": { "README.md": "no descriptor", "META-INF/SIG-CUSTOM": "signature" },
    })
    await expect(signedNonRewriteable.run()).rejects.toThrow("other.jar")
  })

  it("discards the first rewritten artifact when the second repack fails", async () => {
    const source = await setup({
      "one.jar": { "plugin.yml": "version: one" },
      "two.jar": { "plugin.yml": "version: two" },
    })
    const originalGenerate = JSZip.prototype.generateAsync
    let repacks = 0
    const spy = vi.spyOn(JSZip.prototype, "generateAsync").mockImplementation(function (this: JSZip, options) {
      if (++repacks === 2) throw new Error("deliberate second repack failure")
      return originalGenerate.call(this, options)
    })
    try {
      await expect(source.run()).rejects.toThrow("deliberate second repack failure")
    } finally {
      spy.mockRestore()
    }
    await expect(readFile(path.join(source.final, "target", "one-slug-abcdef1.jar"))).rejects.toThrow()
    await expect(readFile(path.join(source.output, "manifest.json"))).rejects.toThrow()
  })

  it("does not rename or recompress when rewriting is disabled or release mode", async () => {
    for (const overrides of [{ rewrite_version: false }, { source_mode: "release" }]) {
      const source = await setup(
        { "one.jar": { "plugin.yml": "version: 1" } },
        { artifact_name_template: "custom-{version}", ...overrides }
      )
      const result = await source.run()
      expect(result.artifactPaths).toEqual([path.join(source.final, "target", "one.jar")])
      expect(await readFile(result.artifactPaths[0]!)).toEqual(
        await readFile(path.join(source.raw, "target", "one.jar"))
      )
    }
  })

  it("uses the three manual no-name-template fallback paths", async () => {
    for (const [jarVersion, versionTemplate, expected] of [
      ["1.0", "fixed-{commit_sha}", "fixed-abcdef1"],
      ["1.0", undefined, "1.0"],
      ["invalid value", undefined, "branch-main-abcdef1"],
    ] as const) {
      const source = await setup(
        { "one.jar": { "plugin.yml": `version: '${jarVersion}'` } },
        {
          name_template: undefined,
          version_template: versionTemplate,
        }
      )
      const result = await source.run()
      expect(JSON.parse(await readFile(result.manifestPath, "utf8"))).toMatchObject({
        version: expected,
        name: expected,
      })
      const jar = await JSZip.loadAsync(await readFile(result.artifactPaths[0]!))
      expect(await jar.file("plugin.yml")!.async("string")).toContain(expected)
    }
    const missingPrimary = await setup(
      {
        "a-primary.jar": { "README.md": "no version" },
        "b-plugin.jar": { "plugin.yml": "version: '1.0'" },
      },
      { name_template: undefined, version_template: undefined }
    )
    const result = await missingPrimary.run()
    expect(JSON.parse(await readFile(result.manifestPath, "utf8"))).toMatchObject({
      version: "branch-main-abcdef1",
      name: "branch-main-abcdef1",
    })
  })

  it("round-trips 64-character display names and rejects 65 or invalid characters", async () => {
    for (const descriptor of [
      { "plugin.yml": "version: old" },
      { "fabric.mod.json": '{"version":"old"}' },
      { "META-INF/mods.toml": '[[mods]]\nversion = "old"\n' },
    ] as Record<string, string>[]) {
      const target = '"#\\!'.repeat(16)
      const source = await setup({ "one.jar": descriptor }, { name_template: target })
      const result = await source.run()
      expect(JSON.parse(await readFile(result.manifestPath, "utf8")).name).toBe(target)
      const invalid = await setup({ "one.jar": descriptor }, { name_template: `${target}x` })
      await expect(invalid.run()).rejects.toThrow("Rendered name template is invalid")
    }
    for (const name of ["", "   ", "x\u0000y", "x\u200by"]) {
      const source = await setup({ "one.jar": { "plugin.yml": "version: 1" } }, { name_template: name })
      await expect(source.run()).rejects.toThrow("Rendered name template is invalid")
    }
  })

  it("enforces template length on input and 128 characters after expansion", async () => {
    expect(
      buildPayloadSchema.safeParse({ ...branchPayload, artifact_name_template: `${"a".repeat(247)}{version}` }).success
    ).toBe(true)
    expect(
      buildPayloadSchema.safeParse({ ...branchPayload, artifact_name_template: `${"a".repeat(248)}{version}` }).success
    ).toBe(false)
    const suffix = "-slug-abcdef1.jar"
    for (const length of [128, 129]) {
      const source = await setup(
        { "one.jar": { "plugin.yml": "version: old" } },
        {
          artifact_name_template: `${"a".repeat(length - suffix.length)}-{version}`,
        }
      )
      if (length === 128) expect(path.basename((await source.run()).artifactPaths[0]!)).toHaveLength(128)
      else await expect(source.run()).rejects.toThrow("invalid final artifact name")
    }
  })

  it("allows a final name identical to its raw name", async () => {
    const source = await setup(
      { "slug-abcdef1.jar": { "plugin.yml": "version: old" } },
      {
        artifact_name_template: "{version}",
      }
    )
    expect(path.basename((await source.run()).artifactPaths[0]!)).toBe("slug-abcdef1.jar")
  })

  it("uses the legacy manifest display name as rewrite target without changing legacy name generation", async () => {
    const source = await setup(
      { "one.jar": { "plugin.yml": "version: old" } },
      {
        source_resolved_identifier: undefined,
        name_template: "ignored-name-template",
      }
    )
    const result = await source.run()
    const manifest = runnerManifestSchema.parse(JSON.parse(await readFile(result.manifestPath, "utf8")))
    expect(manifest).toMatchObject({ version: "branch-main-abcdef1", name: "Auto Build main" })
    const jar = await JSZip.loadAsync(await readFile(result.artifactPaths[0]!))
    expect(await jar.file("plugin.yml")!.async("string")).toContain("Auto Build main")
  })
})
