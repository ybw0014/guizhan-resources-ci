import { readFile } from "node:fs/promises"

import JSZip from "jszip"
import { parse as parseToml, stringify as stringifyToml } from "smol-toml"
import YAML from "yaml"

import { JAR_MANIFEST_PATH, JAR_METADATA_PATHS, JAR_SIGNATURE_MARKER_REGEX, JAR_VERSION_PRIORITY } from "./config.js"

type MetadataPath = (typeof JAR_METADATA_PATHS)[number]
type ObjectValue = Record<string, unknown>

function asObject(value: unknown): ObjectValue | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as ObjectValue) : undefined
}

function parseVersion(
  filename: MetadataPath,
  content: string
): { version: string; mustRewrite?: boolean; rewrite: (target: string) => string } {
  if (filename.endsWith(".yml")) {
    const document = YAML.parseDocument(content, { uniqueKeys: true })
    if (document.errors.length) throw document.errors[0]
    const data = asObject(document.toJS())
    const value = data?.version
    if ((typeof value !== "string" || !value.trim()) && (typeof value !== "number" || !Number.isFinite(value))) {
      throw new Error("missing or invalid version")
    }
    return {
      version: String(value),
      mustRewrite: typeof value === "number",
      rewrite: (target) => YAML.stringify({ ...data, version: target }),
    }
  }

  if (filename.endsWith(".json")) {
    const data = asObject(JSON.parse(content))
    const owner = filename === "quilt.mod.json" ? asObject(data?.quilt_loader) : data
    if (typeof owner?.version !== "string" || !owner.version.trim()) throw new Error("missing or invalid version")
    return {
      version: owner.version,
      rewrite: (target) =>
        JSON.stringify({
          ...data,
          ...(filename === "quilt.mod.json" ? { quilt_loader: { ...owner, version: target } } : { version: target }),
        }),
    }
  }

  const data = parseToml(content)
  const mods = data.mods
  if (
    !Array.isArray(mods) ||
    !mods.length ||
    mods.some((entry) => {
      const version = asObject(entry)?.version
      return typeof version !== "string" || !version.trim()
    })
  ) {
    throw new Error("missing or invalid [[mods]] version")
  }
  return {
    version: asObject(mods[0])!.version as string,
    rewrite: (target) =>
      stringifyToml({ ...data, mods: mods.map((entry) => ({ ...asObject(entry), version: target })) }),
  }
}

export function parseManifestMetadata(content: string): { version?: string } {
  const unfolded = content.replace(/\r?\n /g, "")
  const metadata: { version?: string } = {}
  for (const line of unfolded.split(/\r?\n/)) {
    const match = /^Implementation-Version:\s*(.*?)\s*$/.exec(line)
    if (!match) continue

    const value = match[1]!.trim()
    if (value) metadata.version = value
  }
  return metadata
}

export function assertRewrittenVersion(filename: MetadataPath, content: string, target: string) {
  const decoded = parseVersion(filename, content)
  if (filename.endsWith(".toml")) {
    const mods = parseToml(content).mods as ObjectValue[]
    if (mods.some((mod) => mod.version !== target))
      throw new Error(`${filename}: rewritten version does not match target`)
  } else if (decoded.mustRewrite || decoded.version !== target) {
    throw new Error(`${filename}: rewritten version does not match target`)
  }
}

export async function inspectJar(filePath: string) {
  let zip: JSZip
  try {
    zip = await JSZip.loadAsync(await readFile(filePath))
  } catch (error) {
    throw new Error(`${filePath}: invalid JAR: ${error instanceof Error ? error.message : String(error)}`)
  }
  const entries = [] as {
    filename: MetadataPath
    version: string
    mustRewrite?: boolean
    rewrite: (target: string) => string
  }[]
  for (const filename of JAR_METADATA_PATHS) {
    const entry = zip.file(filename)
    if (!entry) continue
    try {
      entries.push({ filename, ...parseVersion(filename, await entry.async("string")) })
    } catch (error) {
      throw new Error(`${filePath}: ${filename}: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
  const metadataVersion = JAR_VERSION_PRIORITY.map(
    (name) => entries.find((entry) => entry.filename === name)?.version
  ).find(Boolean)
  const manifest = metadataVersion ? undefined : zip.file(JAR_MANIFEST_PATH)
  const originalVersion =
    metadataVersion ?? (manifest ? parseManifestMetadata(await manifest.async("string")).version : undefined)
  return { zip, entries, originalVersion }
}

export function assertUnsignedJar(zip: JSZip, filePath: string) {
  const signature = Object.keys(zip.files).find((name) => JAR_SIGNATURE_MARKER_REGEX.test(name))
  if (signature) throw new Error(`${filePath}: signed JAR (${signature}); disable version rewriting`)
}

export async function rewriteJar(
  inspection: Awaited<ReturnType<typeof inspectJar>>,
  filePath: string,
  target: string
): Promise<Buffer> {
  const { zip, entries } = inspection
  for (const { filename, version, mustRewrite, rewrite } of entries) {
    try {
      if (
        version === target &&
        !mustRewrite &&
        (!filename.endsWith(".toml") ||
          (parseToml(await zip.file(filename)!.async("string")).mods as ObjectValue[]).every(
            (mod) => mod.version === target
          ))
      )
        continue
      const entry = zip.file(filename)!
      const content = rewrite(target)
      assertRewrittenVersion(filename, content, target)
      zip.file(filename, content, {
        date: entry.date,
        unixPermissions: entry.unixPermissions,
        dosPermissions: entry.dosPermissions,
        comment: entry.comment,
        createFolders: false,
      })
      console.info(`${filePath}: ${filename}: ${version} -> ${target}`)
    } catch (error) {
      throw new Error(`${filePath}: ${filename}: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
  const platform = Object.values(zip.files).some((entry) => entry.unixPermissions !== null) ? "UNIX" : "DOS"
  const bytes = await zip.generateAsync({ type: "nodebuffer", platform })
  const verified = await JSZip.loadAsync(bytes)
  for (const { filename } of entries) {
    try {
      assertRewrittenVersion(filename, await verified.file(filename)!.async("string"), target)
    } catch (error) {
      throw new Error(`${filePath}: ${filename}: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
  return bytes
}
