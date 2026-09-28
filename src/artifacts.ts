import { createHash } from "node:crypto"
import { copyFile, lstat, mkdir, mkdtemp, readdir, readFile, rename, rm, writeFile } from "node:fs/promises"
import path from "node:path"

import JSZip from "jszip"

import {
  ARTIFACT_FILE_NAME_REGEX,
  ARTIFACT_NAME_MAX_LENGTH,
  ARTIFACT_NAME_SAFE_REGEX,
  ARTIFACT_SEARCH_PATHS,
  FINAL_ARTIFACT_SUFFIX,
  WINDOWS_DEVICE_NAME_REGEX,
} from "./config.js"
import { readPrimaryJarMetadata } from "./jar-metadata.js"
import { assertUnsignedJar, inspectJar, rewriteJar } from "./jar-version.js"
import { scanMinecraftCompatibility, scanPlatformDescriptors } from "./minecraft-compatibility.js"
import { generateArtifactName } from "./names.js"
import { BuildPayload, RunnerManifest, runnerManifestSchema } from "./schema.js"
import { createTemplateValues, renderTemplate, validateFilenameTemplate } from "./templates.js"

export const DEFAULT_ARTIFACT_SEARCH_PATHS = ARTIFACT_SEARCH_PATHS

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
    await lstat(filePath)
    return true
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false
    throw error
  }
}

async function walkFiles(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true })
  const files = await Promise.all(
    entries.map(async (entry) => {
      const entryPath = path.join(directory, entry.name)

      if (entry.isSymbolicLink()) throw new Error(`Symlink in artifact output: ${entryPath}`)
      if (entry.isDirectory()) {
        return walkFiles(entryPath)
      }

      return entry.isFile() ? [entryPath] : []
    })
  )

  return files.flat()
}

export async function collectArtifactFiles(
  sourceDirectory: string,
  searchPaths = DEFAULT_ARTIFACT_SEARCH_PATHS
): Promise<string[]> {
  const collected = new Set<string>()

  if ((await lstat(sourceDirectory)).isSymbolicLink()) throw new Error(`Symlink in artifact output: ${sourceDirectory}`)

  for (const searchPath of searchPaths) {
    let absolutePath = sourceDirectory
    let missing = false
    for (const segment of searchPath.split("/")) {
      absolutePath = path.join(absolutePath, segment)
      if (!(await fileExists(absolutePath))) {
        missing = true
        break
      }
      const info = await lstat(absolutePath)
      if (info.isSymbolicLink()) throw new Error(`Symlink in artifact output: ${absolutePath}`)
      if (!info.isDirectory()) throw new Error(`Artifact output is not a directory: ${absolutePath}`)
    }
    if (missing) continue
    const files = await walkFiles(absolutePath)

    for (const file of files) {
      if (/\.(?:jar|zip)$/i.test(file)) {
        collected.add(file)
      }
    }
  }

  return [...collected].sort()
}

function assertUniqueBasenames(files: string[]) {
  const names = new Set<string>()
  for (const file of files) {
    const name = path.basename(file).toLowerCase()
    if (names.has(name)) throw new Error(`Duplicate artifact basename: ${path.basename(file)}`)
    names.add(name)
  }
}

async function copyArtifacts(sourceDirectory: string, outputDirectory: string, files: string[]) {
  const relative = path.relative(path.resolve(outputDirectory), path.resolve(sourceDirectory))
  if (relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative))) {
    throw new Error("Artifact output must not contain the input directory")
  }
  await rm(outputDirectory, { recursive: true, force: true })
  for (const file of files) {
    const destination = path.join(outputDirectory, path.relative(sourceDirectory, file))
    await mkdir(path.dirname(destination), { recursive: true })
    await copyFile(file, destination)
  }
}

export async function stageArtifacts(buildDirectory: string, stagingDirectory: string) {
  const files = await collectArtifactFiles(buildDirectory)
  if (files.length === 0) throw new Error("No .jar or .zip build artifacts found")
  assertUniqueBasenames(files)
  await copyArtifacts(buildDirectory, stagingDirectory, files)
  return files.map((file) => path.join(stagingDirectory, path.relative(buildDirectory, file)))
}

export async function finalizeArtifacts(
  payload: BuildPayload,
  rawDirectory: string,
  finalDirectory: string,
  outputDirectory: string
) {
  const files = await collectArtifactFiles(rawDirectory)
  if (files.length === 0) throw new Error("No .jar or .zip build artifacts found")
  assertUniqueBasenames(files)
  if (!payload.rewrite_version || payload.source_mode === "release") {
    await copyArtifacts(rawDirectory, finalDirectory, files)
    return writeManifestAndMetadata(payload, finalDirectory, outputDirectory)
  }

  // All detection and template resolution use raw artifacts; final names never influence primary selection.
  const rawManifest = await resolveRunnerManifest(payload, files)
  const inspections = await Promise.all(
    files.map((file) =>
      /\.jar$/i.test(file) && !/(?:-sources|-javadoc)\.jar$/i.test(file) ? inspectJar(file) : undefined
    )
  )
  if (!inspections.some((inspection) => inspection?.entries.length)) {
    throw new Error("Version rewriting requires at least one JAR with supported metadata")
  }
  const template = payload.artifact_name_template || "{basename}-{version}"
  validateFilenameTemplate(template)
  if (template.includes("{channel_seq}") && payload.channel_version_count === undefined) {
    throw new Error("Artifact filename template requires channel_version_count for {channel_seq}")
  }
  const names = files.map((file, index) => {
    const original = path.basename(file)
    const ext = original.slice(original.lastIndexOf("."))
    const name =
      renderTemplate(template, {
        ...createTemplateValues(payload, inspections[index]?.originalVersion),
        version: rawManifest.version,
        basename: original.slice(0, -ext.length),
      }) + ext
    if (
      name.length < 1 ||
      name.length > ARTIFACT_NAME_MAX_LENGTH ||
      !ARTIFACT_NAME_SAFE_REGEX.test(name) ||
      !ARTIFACT_FILE_NAME_REGEX.test(name) ||
      WINDOWS_DEVICE_NAME_REGEX.test(name)
    )
      throw new Error(`${original}: invalid final artifact name: ${name}`)
    return name
  })
  if (new Set(names.map((name) => name.toLowerCase())).size !== names.length) {
    throw new Error("Duplicate final artifact name")
  }
  for (let index = 0; index < files.length; index++) {
    if (!/\.jar$/i.test(files[index]!)) continue
    let zip = inspections[index]?.zip
    if (!zip) {
      try {
        zip = await JSZip.loadAsync(await readFile(files[index]!))
      } catch (error) {
        throw new Error(`${files[index]}: invalid JAR: ${error instanceof Error ? error.message : String(error)}`)
      }
    }
    assertUnsignedJar(zip, files[index]!)
  }
  for (let index = 0; index < files.length; index++) {
    const inspection = inspections[index]
    console.info(
      `${files[index]}: metadata=${inspection?.entries.map((entry) => entry.filename).join(",") || "none"} original=${inspection?.originalVersion ?? "none"} target=${rawManifest.name} final=${names[index]}`
    )
  }

  const temporaryDirectory = await mkdtemp(`${path.resolve(finalDirectory)}-tmp-`)
  try {
    const finalPaths: string[] = []
    for (let index = 0; index < files.length; index++) {
      const destination = path.join(
        temporaryDirectory,
        path.dirname(path.relative(rawDirectory, files[index]!)),
        names[index]!
      )
      await mkdir(path.dirname(destination), { recursive: true })
      const inspection = inspections[index]
      if (inspection?.entries.length) {
        await writeFile(destination, await rewriteJar(inspection, files[index]!, rawManifest.name))
      } else {
        console.info(`${files[index]}: no supported metadata; copied as ${names[index]}`)
        await copyFile(files[index]!, destination)
      }
      finalPaths.push(destination)
    }
    const artifacts = await Promise.all(finalPaths.map(hashArtifact))
    const manifest = runnerManifestSchema.parse({
      ...rawManifest,
      artifacts: artifacts.map((artifact) => ({
        name: artifact.name,
        url: `https://github.com/${payload.runner_repo}/actions/runs/${process.env.GITHUB_RUN_ID ?? "1"}/artifacts/${encodeURIComponent(artifact.name)}`,
        sha1: artifact.sha1,
        sha256: artifact.sha256,
        size: artifact.size,
      })),
    })
    await rm(finalDirectory, { recursive: true, force: true })
    await rename(temporaryDirectory, finalDirectory)
    return writeManifestAndMetadata(
      payload,
      finalDirectory,
      outputDirectory,
      manifest,
      finalPaths.map((file) => path.join(finalDirectory, path.relative(temporaryDirectory, file)))
    )
  } finally {
    await rm(temporaryDirectory, { recursive: true, force: true })
  }
}

export async function hashArtifact(filePath: string): Promise<ArtifactHash> {
  const bytes = await readFile(filePath)

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
  resolvedVersion: string,
  values: ReturnType<typeof createTemplateValues>
) {
  if (
    payload.name_template ||
    (payload.rewrite_version && payload.source_mode !== "release" && payload.name_template !== undefined)
  ) {
    const name = renderTemplate(payload.name_template, values).trim()
    if (!isValidName(name)) throw new Error("Rendered name template is invalid")
    return name
  }

  return resolvedVersion
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
  return runnerManifestSchema.parse(await resolveRunnerManifest(payload, artifactFiles, artifactBaseUrl))
}

async function resolveRunnerManifest(
  payload: BuildPayload,
  artifactFiles: string[],
  artifactBaseUrl = `https://github.com/${payload.runner_repo}/actions/runs/${process.env.GITHUB_RUN_ID ?? "1"}/artifacts`
) {
  if (artifactFiles.length === 0) {
    throw new Error("No .jar or .zip build artifacts found")
  }

  const artifacts = await Promise.all(artifactFiles.map((file) => hashArtifact(file)))
  const detectPlatforms = payload.detect_platforms === true
  const compatibility = payload.canonical_minecraft_versions
    ? await scanMinecraftCompatibility(artifactFiles, payload.canonical_minecraft_versions)
    : undefined
  const platformScan =
    detectPlatforms && !payload.canonical_minecraft_versions ? await scanPlatformDescriptors(artifactFiles) : undefined
  const platformDetection = compatibility ?? platformScan
  if (detectPlatforms && !platformDetection?.hasRecognizedDescriptor) {
    throw new Error("detect_platforms is enabled but no supported descriptor was found in build artifacts")
  }
  if (compatibility && !compatibility.hasRecognizedDescriptor) {
    console.warn("No supported Minecraft compatibility descriptor found in build artifacts")
  }
  if (compatibility?.hasRecognizedDescriptor && compatibility.minecraftVersions === undefined) {
    console.warn("Supported Minecraft compatibility descriptors declared no Minecraft version constraints")
  }
  const compatibilityFields = platformDetection?.hasRecognizedDescriptor
    ? {
        platforms: platformDetection.platforms,
        ...(compatibility?.minecraftVersions ? { minecraft_versions: compatibility.minecraftVersions } : {}),
      }
    : undefined
  const isMetadataCapable = payload.source_resolved_identifier !== undefined
  if (!isMetadataCapable) {
    return {
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
      ...(compatibilityFields ?? { platforms: ["paper"] }),
      dependencies: [],
      artifacts: artifacts.map((artifact) => ({
        name: artifact.name,
        url: `${artifactBaseUrl}/${encodeURIComponent(artifact.name)}`,
        sha1: artifact.sha1,
        sha256: artifact.sha256,
        size: artifact.size,
      })),
    }
  }

  const jarMetadata = await readPrimaryJarMetadata(
    artifactFiles,
    payload.rewrite_version && payload.source_mode !== "release"
  )
  const templateValues = createTemplateValues(payload, jarMetadata.version)
  const version = resolveManifestVersion(payload, jarMetadata.version, templateValues)
  const manifest = {
    run_id: payload.run_id,
    project_id: payload.project_id,
    channel: payload.channel,
    source_mode: payload.source_mode,
    source_identifier: payload.source_identifier,
    source_commit_sha: payload.source_commit_sha,
    build_profile: payload.build_profile,
    version,
    name: resolveManifestName(payload, version, templateValues),
    changelog: resolveManifestChangelog(payload, templateValues),
    ...(compatibilityFields ?? { platforms: ["paper"] }),
    dependencies: [],
    artifacts: artifacts.map((artifact) => ({
      name: artifact.name,
      url: `${artifactBaseUrl}/${encodeURIComponent(artifact.name)}`,
      sha1: artifact.sha1,
      sha256: artifact.sha256,
      size: artifact.size,
    })),
  }

  return manifest
}

export async function writeManifestAndMetadata(
  payload: BuildPayload,
  sourceDirectory: string,
  outputDirectory: string,
  resolvedManifest?: RunnerManifest,
  resolvedPaths?: string[]
): Promise<RunnerArtifactMetadata> {
  const artifactPaths = resolvedPaths ?? (await collectArtifactFiles(sourceDirectory))
  assertUniqueBasenames(artifactPaths)
  const manifest = resolvedManifest ?? (await createRunnerManifest(payload, artifactPaths))
  const manifestArtifactName = generateArtifactName(payload.idempotency_key, "manifest")
  const buildArtifactName = generateArtifactName(payload.idempotency_key, FINAL_ARTIFACT_SUFFIX)
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
