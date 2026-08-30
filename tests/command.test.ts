import { chmod, mkdtemp, rm, stat, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"

import { afterEach, beforeEach, describe, expect, it } from "vitest"

import { ensureExecutable } from "../src/command.js"

let testDirectory: string

beforeEach(async () => {
  testDirectory = await mkdtemp(path.join(tmpdir(), "guizhan-resources-command-test-"))
})

afterEach(async () => {
  await rm(testDirectory, { force: true, recursive: true })
})

describe("ensureExecutable", () => {
  it("adds the executable bit to a relative-path script missing it", async () => {
    const scriptPath = path.join(testDirectory, "gradlew")
    await writeFile(scriptPath, "#!/bin/sh\nexit 0\n")
    await chmod(scriptPath, 0o644)

    ensureExecutable("./gradlew", testDirectory)

    const result = await stat(scriptPath)
    expect(result.mode & 0o111).not.toBe(0)
  })

  it("keeps an already-executable script untouched", async () => {
    const scriptPath = path.join(testDirectory, "gradlew")
    await writeFile(scriptPath, "#!/bin/sh\nexit 0\n")
    await chmod(scriptPath, 0o755)

    ensureExecutable("./gradlew", testDirectory)

    const result = await stat(scriptPath)
    expect(result.mode & 0o777).toBe(0o755)
  })

  it("ignores commands that are not relative paths", async () => {
    // Must not throw or touch the filesystem
    ensureExecutable("mvn", testDirectory)
    ensureExecutable("/usr/bin/env", testDirectory)
  })

  it("does not throw when the script does not exist", () => {
    ensureExecutable("./missing.sh", testDirectory)
  })
})
