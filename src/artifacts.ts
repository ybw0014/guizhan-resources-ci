import { createHash } from "node:crypto"
import { mkdir, readdir, stat, writeFile } from "node:fs/promises"
import path from "node:path"

import { readPrimaryJarMetadata } from "./jar-metadata.js"
import { generateArtifactName } from "./names.js"
import { BuildPayload, RunnerManifest, runnerManifestSchema } from "./schema.js"
import { createTemplateValues, renderTemplate } from "./templates.js"

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
  const version = prefix
    .replace(/[^a-zA-Z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 32)

  return version || payload.source_commit_sha.slice(0, 7)
}

function isValidVersion(value: string) {
  return /^[a-zA-Z0-9!@$()`.+,_"-]+$/.test(value) && value.length <= 32
}

function isValidName(value: string) {
  return value.length >= 1 && value.length <= 64 && /^[^\p{Cc}\p{Cf}]+$/u.test(value)
}

function resolvedIdentifier(payload: BuildPayload) {
  return payload.source_resolved_identifier ?? payload.source_identifier
}

function resolveManifestVersion(
  payload: BuildPayload,
  jarVersion: string | undefined,
  values: ReturnType<typeof createTemplateValues>
) {
  if (payload.version_template) {
    const version = renderTemplate(payload.version_template, values).trim()
    if (!isValidVersion(version)) throw new Error("Rendered version template is invalid")
    return version
  }

  const version = jarVersion?.trim()
  return version && isValidVersion(version) ? version : createManifestVersion(payload)
}

function resolveManifestName(
  payload: BuildPayload,
  jarName: string | undefined,
  values: ReturnType<typeof createTemplateValues>
) {
  if (payload.name_template) {
    const name = renderTemplate(payload.name_template, values).trim()
    if (!isValidName(name)) throw new Error("Rendered name template is invalid")
    return name
  }

  const name = jarName?.trim()
  return name && isValidName(name) ? name : `Auto Build ${resolvedIdentifier(payload)}`.slice(0, 64)
}

function resolveManifestChangelog(payload: BuildPayload, values: ReturnType<typeof createTemplateValues>) {
  if (payload.changelog_template) {
    const changelog = renderTemplate(payload.changelog_template, values)
    if (changelog.length > 10000) throw new Error("Rendered changelog template is too long")
    return changelog
  }

  return payload.source_commit_message || `Built from ${payload.source_repo}@${payload.source_commit_sha}`
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
  const isMetadataCapable = payload.source_resolved_identifier !== undefined
  if (!isMetadataCapable) {
    return runnerManifestSchema.parse({
      run_id: payload.run_id,
      project_id: payload.project_id,
      channel: payload.channel,
      source_mode: payload.source_mode,
      source_identifier: payload.source_identifier,
      source_commit_sha: payload.source_commit_sha,
      build_profile: payload.build_profile,
      version: createManifestVersion(payload),
      name: `Auto Build ${payload.source_identifier}`.slice(0, 64),
      changelog: `Built from ${payload.source_repo}@${payload.source_commit_sha}`,
      platforms: ["paper"],
      dependencies: [],
      artifacts: artifacts.map((artifact) => ({
        name: artifact.name,
        url: `${artifactBaseUrl}/${encodeURIComponent(artifact.name)}`,
        sha1: artifact.sha1,
        sha256: artifact.sha256,
        size: artifact.size,
      })),
    })
  }

  const jarMetadata = await readPrimaryJarMetadata(artifactFiles)
  const templateValues = createTemplateValues(payload, jarMetadata.version)
  const manifest = {
    run_id: payload.run_id,
    project_id: payload.project_id,
    channel: payload.channel,
    source_mode: payload.source_mode,
    source_identifier: payload.source_identifier,
    source_commit_sha: payload.source_commit_sha,
    build_profile: payload.build_profile,
    version: resolveManifestVersion(payload, jarMetadata.version, templateValues),
    name: resolveManifestName(payload, jarMetadata.name, templateValues),
    changelog: resolveManifestChangelog(payload, templateValues),
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
