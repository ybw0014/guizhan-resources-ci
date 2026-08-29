import { readFile } from "node:fs/promises"
import path from "node:path"

import JSZip from "jszip"

export type JarMetadata = {
  name?: string
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
    const match = /^(name|version):\s*(.*?)\s*$/.exec(line)
    if (!match) continue

    const value = match[2]!.replace(/^['"]|['"]$/g, "").trim()
    if (value) metadata[match[1]! as keyof JarMetadata] = value
  }
  return metadata
}

function parseManifestMetadata(content: string): JarMetadata {
  const unfolded = content.replace(/\r?\n /g, "")
  const metadata: JarMetadata = {}
  for (const line of unfolded.split(/\r?\n/)) {
    const match = /^(Implementation-Title|Implementation-Version):\s*(.*?)\s*$/.exec(line)
    if (!match) continue

    const value = match[2]!.trim()
    if (value) metadata[match[1] === "Implementation-Title" ? "name" : "version"] = value
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

export async function readPrimaryJarMetadata(artifactPaths: string[]): Promise<JarMetadata> {
  const primaryJar = selectPrimaryJar(artifactPaths)
  if (!primaryJar) return {}

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
    ["META-INF/MANIFEST.MF", parseManifestMetadata],
  ] as const) {
    const content = await readZipEntry(zip, filename)
    if (!content) continue

    const candidate = parse(content)
    metadata.name ??= candidate.name
    metadata.version ??= candidate.version
  }

  return metadata
}
