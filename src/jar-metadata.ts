import { readFile } from "node:fs/promises"
import path from "node:path"

import JSZip from "jszip"
import { JAR_MANIFEST_PATH } from "./config.js"
import { inspectJar, parseManifestMetadata } from "./jar-version.js"

export type JarMetadata = {
  version?: string
}

export function selectPrimaryJar(artifactPaths: string[]): string | undefined {
  return [...artifactPaths].sort().find((artifactPath) => {
    const basename = path.basename(artifactPath)
    return /\.jar$/i.test(basename) && !/(?:-sources|-javadoc)\.jar$/i.test(basename)
  })
}

function parseYamlMetadata(content: string): JarMetadata {
  const metadata: JarMetadata = {}
  for (const line of content.split(/\r?\n/)) {
    const match = /^version:\s*(.*?)\s*$/.exec(line)
    if (!match) continue

    const value = match[1]!.replace(/^['"]|['"]$/g, "").trim()
    if (value) metadata.version = value
  }
  return metadata
}

async function readZipEntry(zip: JSZip, filename: string): Promise<string | undefined> {
  try {
    const entry = zip.file(filename)
    return entry ? await entry.async("string") : undefined
  } catch {
    return undefined
  }
}

export async function readPrimaryJarMetadata(artifactPaths: string[], rewriteVersion = false): Promise<JarMetadata> {
  const primaryJar = selectPrimaryJar(artifactPaths)
  if (!primaryJar) return {}

  if (rewriteVersion) {
    const inspection = await inspectJar(primaryJar)
    return inspection.originalVersion ? { version: inspection.originalVersion } : {}
  }

  let zip: JSZip
  try {
    zip = await JSZip.loadAsync(await readFile(primaryJar))
  } catch {
    return {}
  }

  const metadata: JarMetadata = {}
  for (const [filename, parse] of [
    ["paper-plugin.yml", parseYamlMetadata],
    ["plugin.yml", parseYamlMetadata],
    [JAR_MANIFEST_PATH, parseManifestMetadata],
  ] as const) {
    const content = await readZipEntry(zip, filename)
    if (!content) continue

    const candidate = parse(content)
    metadata.version ??= candidate.version
  }

  return metadata
}
