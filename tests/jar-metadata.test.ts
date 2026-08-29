import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"

import JSZip from "jszip"
import { afterEach, describe, expect, it } from "vitest"

import { readPrimaryJarMetadata, selectPrimaryJar } from "../src/jar-metadata.js"

const directories: string[] = []

async function createJar(files: Record<string, string>) {
  const directory = await mkdtemp(path.join(tmpdir(), "guizhan-ci-jar-"))
  directories.push(directory)
  const jarPath = path.join(directory, "plugin.jar")
  const zip = new JSZip()
  for (const [filename, content] of Object.entries(files)) zip.file(filename, content)
  await writeFile(jarPath, await zip.generateAsync({ type: "nodebuffer" }))
  return jarPath
}

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })))
})

describe("primary JAR metadata", () => {
  it("uses paper-plugin.yml before plugin.yml and MANIFEST.MF", async () => {
    const jar = await createJar({
      "paper-plugin.yml": "name: Paper Name\nversion: 2.0.0\n",
      "plugin.yml": "name: Plugin Name\nversion: 1.0.0\n",
      "META-INF/MANIFEST.MF": "Implementation-Title: Manifest Name\nImplementation-Version: 0.1.0\n",
    })

    await expect(readPrimaryJarMetadata([jar])).resolves.toEqual({ name: "Paper Name", version: "2.0.0" })
  })

  it("falls through missing values and handles manifest continuation lines", async () => {
    const jar = await createJar({
      "paper-plugin.yml": "name: Paper Name\n",
      "META-INF/MANIFEST.MF": "Implementation-Version: 1.\n 2.3\n",
    })

    await expect(readPrimaryJarMetadata([jar])).resolves.toEqual({ name: "Paper Name", version: "1.2.3" })
  })

  it("uses case-sensitive entry paths and ignores invalid ZIPs", async () => {
    const jar = await createJar({ "Plugin.yml": "name: Wrong Case\nversion: 1.0.0\n" })
    const invalidPath = path.join(path.dirname(jar), "invalid.jar")
    await writeFile(invalidPath, "not a zip")

    await expect(readPrimaryJarMetadata([jar])).resolves.toEqual({})
    await expect(readPrimaryJarMetadata([invalidPath])).resolves.toEqual({})
  })

  it("sorts before selecting the first non-sources/non-javadoc JAR", () => {
    expect(selectPrimaryJar(["d.JAR", "c.jar", "a-javadoc.jar", "b-sources.jar"])).toBe("c.jar")
  })
})
