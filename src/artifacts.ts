import { createHash } from "node:crypto"
import { mkdir, readdir, stat, writeFile } from "node:fs/promises"
import path from "node:path"

import { generateArtifactName } from "./names.js"
import { BuildPayload, RunnerManifest, runnerManifestSchema } from "./schema.js"

export const DEFAULT_ARTIFACT_SEARCH_PATHS = ["target", "build/libs"]

export type ArtifactHash = {
  name: string
  path: string
  sha1: string
  sha256: string
  size: number
}

export type RunnerArtifactMetadata = {
  manifestArtifactName: string
  buildArtifactName: string
  artifactNames: string[]
  artifactPaths: string[]
  manifestPath: string
}

async function fileExists(filePath: string) {
  try {
    await stat(filePath)
    return true
  } catch {
    return false
  }
}

async function walkFiles(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true })
  const files = await Promise.all(
    entries.map(async (entry) => {
      const entryPath = path.join(directory, entry.name)

      if (entry.isDirectory()) {
        return walkFiles(entryPath)
      }

      return [entryPath]
    })
  )

  return files.flat()
}

export async function collectArtifactFiles(
  sourceDirectory: string,
  searchPaths = DEFAULT_ARTIFACT_SEARCH_PATHS
): Promise<string[]> {
  const collected = new Set<string>()

  for (const searchPath of searchPaths) {
    const absolutePath = path.resolve(sourceDirectory, searchPath)

    if (!(await fileExists(absolutePath))) {
      continue
    }

    const stats = await stat(absolutePath)
    const files = stats.isDirectory() ? await walkFiles(absolutePath) : [absolutePath]

    for (const file of files) {
      if (/\.(?:jar|zip)$/i.test(file)) {
        collected.add(file)
      }
    }
  }

  return [...collected].sort()
}

export async function hashArtifact(filePath: string): Promise<ArtifactHash> {
  const bytes = await import("node:fs/promises").then((fs) => fs.readFile(filePath))

  return {
    name: path.basename(filePath),
    path: filePath,
    sha1: createHash("sha1").update(bytes).digest("hex"),
    sha256: createHash("sha256").update(bytes).digest("hex"),
    size: bytes.byteLength,
  }
}

export function createManifestVersion(payload: BuildPayload): string {
  const prefix = `${payload.source_mode}-${payload.source_identifier}-${payload.source_commit_sha.slice(0, 7)}`
  const version = prefix.replace(/[^a-zA-Z0-9_-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 32)

  return version || payload.source_commit_sha.slice(0, 7)
}

export async function createRunnerManifest(
  payload: BuildPayload,
  artifactFiles: string[],
  artifactBaseUrl = `https://github.com/${payload.runner_repo}/actions/runs/${process.env.GITHUB_RUN_ID ?? "1"}/artifacts`
): Promise<RunnerManifest> {
  if (artifactFiles.length === 0) {
    throw new Error("No .jar or .zip build artifacts found")
  }

  const artifacts = await Promise.all(artifactFiles.map((file) => hashArtifact(file)))
  const manifest = {
    run_id: payload.run_id,
    project_id: payload.project_id,
    channel: payload.channel,
    source_mode: payload.source_mode,
    source_identifier: payload.source_identifier,
    source_commit_sha: payload.source_commit_sha,
    build_profile: payload.build_profile,
    version: createManifestVersion(payload),
    name: `Auto Build ${payload.source_identifier}`,
    changelog: `Built from ${payload.source_repo}@${payload.source_commit_sha}`,
    minecraft_versions: ["unknown"],
    platforms: ["paper"],
    dependencies: [],
    artifacts: artifacts.map((artifact) => ({
      name: artifact.name,
      url: `${artifactBaseUrl}/${encodeURIComponent(artifact.name)}`,
      sha1: artifact.sha1,
      sha256: artifact.sha256,
      size: artifact.size,
    })),
  }

  return runnerManifestSchema.parse(manifest)
}

export async function writeManifestAndMetadata(
  payload: BuildPayload,
  sourceDirectory: string,
  outputDirectory: string
): Promise<RunnerArtifactMetadata> {
  const artifactPaths = await collectArtifactFiles(sourceDirectory)
  const manifest = await createRunnerManifest(payload, artifactPaths)
  const manifestArtifactName = generateArtifactName(payload.idempotency_key, "manifest")
  const buildArtifactName = generateArtifactName(payload.idempotency_key, "build-artifacts")
  const manifestPath = path.join(outputDirectory, "manifest.json")
  const metadataPath = path.join(outputDirectory, "artifact-metadata.json")
  const metadata: RunnerArtifactMetadata = {
    manifestArtifactName,
    buildArtifactName,
    artifactNames: [buildArtifactName],
    artifactPaths,
    manifestPath,
  }

  await mkdir(outputDirectory, { recursive: true })
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`)
  await writeFile(metadataPath, `${JSON.stringify(metadata, null, 2)}\n`)

  return metadata
}
