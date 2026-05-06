import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"

import { afterEach, describe, expect, it } from "vitest"

import { sanitizeBuildEnv } from "../src/command.js"
import { generateArtifactName, generateRunName } from "../src/names.js"
import { BuildPayload, buildPayloadSchema, runnerManifestSchema } from "../src/schema.js"
import { generateManifest, runBuild, validatePayload } from "../src/runner.js"
import branchPayload from "./fixtures/branch-payload.json" with { type: "json" }
import invalidCommandPayload from "./fixtures/invalid-command-payload.json" with { type: "json" }

const tempDirectories: string[] = []
const originalGithubOutput = process.env.GITHUB_OUTPUT
const originalCallbackSecret = process.env.AUTO_BUILD_CALLBACK_SECRET
const originalGithubToken = process.env.GITHUB_TOKEN
const originalActionsRuntimeToken = process.env.ACTIONS_RUNTIME_TOKEN

async function createTempDirectory() {
  const directory = await mkdtemp(path.join(tmpdir(), "guizhan-ci-runner-"))
  tempDirectories.push(directory)

  return directory
}

async function writePayload(directory: string, payload: BuildPayload) {
  const payloadPath = path.join(directory, "payload.json")

  await writeFile(payloadPath, `${JSON.stringify(payload, null, 2)}\n`)

  return payloadPath
}

afterEach(async () => {
  process.env.GITHUB_OUTPUT = originalGithubOutput
  process.env.AUTO_BUILD_CALLBACK_SECRET = originalCallbackSecret
  process.env.GITHUB_TOKEN = originalGithubToken
  process.env.ACTIONS_RUNTIME_TOKEN = originalActionsRuntimeToken

  await Promise.all(tempDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })))
})

describe("runner payload validation", () => {
  it("validates payload before checkout and writes checkout outputs", async () => {
    const directory = await createTempDirectory()
    const payloadPath = path.join(directory, "payload.json")
    const outputPath = path.join(directory, "github-output.txt")
    process.env.GITHUB_OUTPUT = outputPath

    const payload = await validatePayload(JSON.stringify(branchPayload), payloadPath)
    const output = await readFile(outputPath, "utf8")

    expect(payload.source_repo).toBe(branchPayload.source_repo)
    expect(await readFile(payloadPath, "utf8")).toContain(branchPayload.idempotency_key)
    expect(output).toContain(`source_repo=${branchPayload.source_repo}`)
    expect(output).toContain(`source_commit_sha=${branchPayload.source_commit_sha}`)
  })

  it("rejects an invalid command before checkout outputs are created", async () => {
    const directory = await createTempDirectory()
    const payloadPath = path.join(directory, "payload.json")
    const outputPath = path.join(directory, "github-output.txt")
    process.env.GITHUB_OUTPUT = outputPath

    await expect(validatePayload(JSON.stringify(invalidCommandPayload), payloadPath)).rejects.toThrow()
    await expect(readFile(outputPath, "utf8")).rejects.toThrow()
  })

  it("workflow run-name includes run_id and idempotency_key", async () => {
    const directory = await createTempDirectory()
    const outputPath = path.join(directory, "github-output.txt")
    process.env.GITHUB_OUTPUT = outputPath

    await validatePayload(JSON.stringify(branchPayload), path.join(directory, "payload.json"))

    const output = await readFile(outputPath, "utf8")
    const expectedRunName = generateRunName(branchPayload.idempotency_key, branchPayload.run_id)

    expect(expectedRunName).toContain(branchPayload.idempotency_key)
    expect(expectedRunName).toContain(branchPayload.run_id)
    expect(output).toContain(`run_name=${expectedRunName}`)
  })
})

describe("runner build and manifest orchestration", () => {
  it("does not expose callback or GitHub tokens to the build command", async () => {
    const directory = await createTempDirectory()
    const sourceDirectory = path.join(directory, "source")
    const payload = buildPayloadSchema.parse({
      ...branchPayload,
      build_command: "node print-env.mjs",
    })
    const payloadPath = await writePayload(directory, payload)
    const envPath = path.join(sourceDirectory, "env.json")

    await mkdir(sourceDirectory, { recursive: true })
    await writeFile(
      path.join(sourceDirectory, "print-env.mjs"),
      `import { writeFileSync } from "node:fs"\nwriteFileSync(${JSON.stringify(envPath)}, JSON.stringify(process.env, null, 2))\n`
    )
    process.env.AUTO_BUILD_CALLBACK_SECRET = "callback-secret"
    process.env.GITHUB_TOKEN = "github-token"
    process.env.ACTIONS_RUNTIME_TOKEN = "artifact-token"

    await runBuild(payloadPath, sourceDirectory)

    const commandEnv = JSON.parse(await readFile(envPath, "utf8")) as Record<string, string>
    expect(commandEnv.AUTO_BUILD_CALLBACK_SECRET).toBeUndefined()
    expect(commandEnv.GITHUB_TOKEN).toBeUndefined()
    expect(commandEnv.ACTIONS_RUNTIME_TOKEN).toBeUndefined()
    expect(sanitizeBuildEnv(process.env).AUTO_BUILD_CALLBACK_SECRET).toBeUndefined()
  })

  it("generates manifest and artifact metadata from build outputs", async () => {
    const directory = await createTempDirectory()
    const sourceDirectory = path.join(directory, "source")
    const outputDirectory = path.join(directory, "runner-output")
    const artifactDirectory = path.join(sourceDirectory, "target")
    const payload = buildPayloadSchema.parse(branchPayload)
    const payloadPath = await writePayload(directory, payload)
    const outputPath = path.join(directory, "github-output.txt")
    process.env.GITHUB_OUTPUT = outputPath

    await mkdir(artifactDirectory, { recursive: true })
    await writeFile(path.join(artifactDirectory, "plugin.jar"), "fake jar bytes")

    const metadata = await generateManifest(payloadPath, sourceDirectory, outputDirectory)
    const manifest = runnerManifestSchema.parse(
      JSON.parse(await readFile(path.join(outputDirectory, "manifest.json"), "utf8"))
    )
    const output = await readFile(outputPath, "utf8")

    expect(metadata.manifestArtifactName).toBe(generateArtifactName(payload.idempotency_key, "manifest"))
    expect(metadata.buildArtifactName).toBe(generateArtifactName(payload.idempotency_key, "build-artifacts"))
    expect(metadata.artifactPaths).toHaveLength(1)
    expect(manifest).toMatchObject({
      run_id: payload.run_id,
      project_id: payload.project_id,
      channel: payload.channel,
      source_commit_sha: payload.source_commit_sha,
      build_profile: payload.build_profile,
    })
    expect(manifest.artifacts[0]).toMatchObject({
      name: "plugin.jar",
      size: "fake jar bytes".length,
    })
    expect(output).toContain(`manifest_artifact_name=${metadata.manifestArtifactName}`)
    expect(output).toContain(`build_artifact_name=${metadata.buildArtifactName}`)
  })
})
