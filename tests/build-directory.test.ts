import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"

import { afterEach, describe, expect, it } from "vitest"

import { finalizeArtifacts } from "../src/artifacts.js"
import { resolveBuildDirectory } from "../src/build-directory.js"
import { buildPayloadSchema } from "../src/schema.js"
import { runBuild, stageBuildArtifacts } from "../src/runner.js"
import branchPayload from "./fixtures/branch-payload.json" with { type: "json" }

const tempDirectories: string[] = []

async function setup() {
  const directory = await mkdtemp(path.join(tmpdir(), "guizhan-ci-build-directory-"))
  tempDirectories.push(directory)
  const source = path.join(directory, "source")
  await mkdir(source)
  return { directory, source }
}

afterEach(async () => {
  await Promise.all(tempDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })))
})

describe("build directory", () => {
  it("uses the checkout root for legacy payloads", async () => {
    const { source } = await setup()
    expect(await resolveBuildDirectory(source, ".")).toBe(await realpath(source))
    expect(buildPayloadSchema.parse(branchPayload).build_directory).toBe(".")
  })

  it("runs in a two-level Maven directory and stages only its jars in the standard layout", async () => {
    const { directory, source } = await setup()
    const buildDirectory = path.join(source, "projects", "maven")
    await mkdir(path.join(buildDirectory, "target", "nested"), { recursive: true })
    await mkdir(path.join(source, "projects", "sibling", "target"), { recursive: true })
    await writeFile(path.join(buildDirectory, "target", "nested", "plugin.jar"), "maven")
    await writeFile(path.join(buildDirectory, "target", "ignored.txt"), "ignored")
    await writeFile(path.join(source, "projects", "sibling", "target", "sibling.jar"), "sibling")
    const payload = buildPayloadSchema.parse({
      ...branchPayload,
      build_directory: "projects/maven",
      build_command: "node record-cwd.mjs",
    })
    const payloadPath = path.join(directory, "payload.json")
    await writeFile(payloadPath, JSON.stringify(payload))
    await writeFile(
      path.join(buildDirectory, "record-cwd.mjs"),
      `import { writeFileSync } from "node:fs"\nwriteFileSync(${JSON.stringify(path.join(directory, "cwd"))}, process.cwd())\n`
    )

    await runBuild(payloadPath, source)
    const staged = await stageBuildArtifacts(payloadPath, source, path.join(directory, "raw"))
    expect(await readFile(path.join(directory, "cwd"), "utf8")).toBe(await realpath(buildDirectory))
    expect(staged).toEqual([path.join(directory, "raw", "target", "nested", "plugin.jar")])
    expect(await readFile(staged[0]!, "utf8")).toBe("maven")
  })

  it("supports a wrapper relative to the two-level Gradle cwd and stages build/libs only", async () => {
    const { directory, source } = await setup()
    const buildDirectory = path.join(source, "project", "module")
    await mkdir(path.join(buildDirectory, "build", "libs"), { recursive: true })
    await writeFile(path.join(buildDirectory, "build", "libs", "plugin.zip"), "gradle")
    await writeFile(
      path.join(source, "project", "gradlew"),
      `#!/usr/bin/env node\nimport { writeFileSync } from "node:fs"\nwriteFileSync(${JSON.stringify(path.join(directory, "wrapper-cwd"))}, process.cwd())\n`
    )
    const payload = buildPayloadSchema.parse({
      ...branchPayload,
      build_directory: "project/module",
      build_command: "../gradlew build",
    })
    const payloadPath = path.join(directory, "payload.json")
    await writeFile(payloadPath, JSON.stringify(payload))
    await runBuild(payloadPath, source)
    expect(await readFile(path.join(directory, "wrapper-cwd"), "utf8")).toBe(await realpath(buildDirectory))
    expect(await stageBuildArtifacts(payloadPath, source, path.join(directory, "raw"))).toEqual([
      path.join(directory, "raw", "build", "libs", "plugin.zip"),
    ])
  })

  it("rejects invalid paths, missing paths, files and symlinked directory chains", async () => {
    const { directory, source } = await setup()
    await mkdir(path.join(source, "real"))
    await writeFile(path.join(source, "file"), "not a directory")
    await symlink(path.join(source, "real"), path.join(source, "linked"))
    for (const invalid of [
      "",
      "/tmp",
      "C:/temp",
      "foo\\bar",
      "foo//bar",
      "foo/",
      "./foo",
      "foo/..",
      "foo/.git",
      "x".repeat(256),
    ]) {
      expect(buildPayloadSchema.safeParse({ ...branchPayload, build_directory: invalid }).success).toBe(false)
      await expect(resolveBuildDirectory(source, invalid)).rejects.toThrow()
    }
    for (const invalid of ["missing", "file", "linked", "linked/subdir"]) {
      await expect(resolveBuildDirectory(source, invalid)).rejects.toThrow()
    }
    await symlink(source, path.join(directory, "source-link"))
    await expect(resolveBuildDirectory(path.join(directory, "source-link"), ".")).rejects.toThrow()
  })

  it("rejects symlinked artifact files and directories", async () => {
    const { directory, source } = await setup()
    await mkdir(path.join(source, "target"))
    await symlink(directory, path.join(source, "target", "linked"))
    const payloadPath = path.join(directory, "payload.json")
    await writeFile(payloadPath, JSON.stringify(branchPayload))
    await expect(stageBuildArtifacts(payloadPath, source, path.join(directory, "raw"))).rejects.toThrow("Symlink")
    await rm(path.join(source, "target", "linked"))
    await writeFile(path.join(directory, "outside.jar"), "outside")
    await symlink(path.join(directory, "outside.jar"), path.join(source, "target", "linked.jar"))
    await expect(stageBuildArtifacts(payloadPath, source, path.join(directory, "raw"))).rejects.toThrow("Symlink")
  })

  it("rejects duplicate basenames before raw or final output is published", async () => {
    const { directory, source } = await setup()
    await mkdir(path.join(source, "target"))
    await mkdir(path.join(source, "build", "libs"), { recursive: true })
    await writeFile(path.join(source, "target", "Plugin.jar"), "one")
    await writeFile(path.join(source, "build", "libs", "plugin.jar"), "two")
    const payloadPath = path.join(directory, "payload.json")
    await writeFile(payloadPath, JSON.stringify(branchPayload))
    const raw = path.join(directory, "raw")
    await expect(stageBuildArtifacts(payloadPath, source, raw)).rejects.toThrow("Duplicate artifact basename")
    await expect(readFile(path.join(raw, "target", "Plugin.jar"))).rejects.toThrow()
    await expect(
      finalizeArtifacts(
        buildPayloadSchema.parse(branchPayload),
        source,
        path.join(directory, "final"),
        path.join(directory, "output")
      )
    ).rejects.toThrow("Duplicate artifact basename")
    await expect(readFile(path.join(directory, "output", "manifest.json"))).rejects.toThrow()
  })
})
