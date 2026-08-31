import { chmod, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"

import { afterEach, beforeEach, describe, expect, it } from "vitest"

import { prepareCommandScript } from "../src/command.js"

let testDirectory: string

beforeEach(async () => {
  testDirectory = await mkdtemp(path.join(tmpdir(), "guizhan-resources-command-test-"))
})

afterEach(async () => {
  await rm(testDirectory, { force: true, recursive: true })
})

describe("prepareCommandScript", () => {
  it("adds the executable bit to a relative-path script missing it", async () => {
    const scriptPath = path.join(testDirectory, "gradlew")
    await writeFile(scriptPath, "#!/bin/sh\nexit 0\n")
    await chmod(scriptPath, 0o644)

    prepareCommandScript("./gradlew", testDirectory)

    const result = await stat(scriptPath)
    expect(result.mode & 0o111).not.toBe(0)
  })

  it("keeps an already-executable script untouched", async () => {
    const scriptPath = path.join(testDirectory, "gradlew")
    await writeFile(scriptPath, "#!/bin/sh\nexit 0\n")
    await chmod(scriptPath, 0o755)

    prepareCommandScript("./gradlew", testDirectory)

    const result = await stat(scriptPath)
    expect(result.mode & 0o777).toBe(0o755)
  })

  it("normalizes CRLF line endings on shebang scripts", async () => {
    const scriptPath = path.join(testDirectory, "gradlew")
    await writeFile(scriptPath, "#!/bin/sh\r\n\r\nexit 0\r\n")

    prepareCommandScript("./gradlew", testDirectory)

    const content = await readFile(scriptPath, "utf8")
    expect(content).toBe("#!/bin/sh\n\nexit 0\n")
  })

  it("does not rewrite CRLF in files without a shebang", async () => {
    const filePath = path.join(testDirectory, "data.bin")
    const original = Buffer.from([0x00, 0x01, 0x0d, 0x0a, 0x02])
    await writeFile(filePath, original)

    prepareCommandScript("./data.bin", testDirectory)

    const content = await readFile(filePath)
    expect(content.equals(original)).toBe(true)
  })

  it("ignores commands that are not relative paths", async () => {
    // Must not throw or touch the filesystem
    prepareCommandScript("mvn", testDirectory)
    prepareCommandScript("/usr/bin/env", testDirectory)
  })

  it("does not throw when the script does not exist", () => {
    prepareCommandScript("./missing.sh", testDirectory)
  })
})
