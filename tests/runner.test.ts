import { createHmac } from "node:crypto"
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"

import JSZip from "jszip"
import { afterEach, describe, expect, it, vi } from "vitest"

import { sanitizeBuildEnv } from "../src/command.js"
import { generateArtifactName, generateRunName } from "../src/names.js"
import { BuildPayload, buildPayloadSchema, runnerManifestSchema } from "../src/schema.js"
import {
  generateManifest,
  runBuild,
  sendPostBuildCallback,
  stageBuildArtifacts,
  validatePayload,
} from "../src/runner.js"
import branchPayload from "./fixtures/branch-payload.json" with { type: "json" }
import invalidCommandPayload from "./fixtures/invalid-command-payload.json" with { type: "json" }

const tempDirectories: string[] = []
const originalGithubOutput = process.env.GITHUB_OUTPUT
const originalCallbackSecret = process.env.AUTO_BUILD_CALLBACK_SECRET
const originalGithubToken = process.env.GITHUB_TOKEN
const originalActionsRuntimeToken = process.env.ACTIONS_RUNTIME_TOKEN
const originalJobStatus = process.env.JOB_STATUS
const originalBuildErrorMessage = process.env.BUILD_ERROR_MESSAGE
const payloadSecret = "test-build-payload-secret"

async function createTempDirectory() {
  const directory = await mkdtemp(path.join(tmpdir(), "guizhan-ci-runner-"))
  tempDirectories.push(directory)

  return directory
}

function signPayload(rawPayload: string, timestamp = "1700000000", secret = payloadSecret) {
  return {
    secret,
    timestamp,
    signature: `sha256=${createHmac("sha256", secret).update(`${timestamp}.${rawPayload}`).digest("hex")}`,
  }
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
  process.env.JOB_STATUS = originalJobStatus
  process.env.BUILD_ERROR_MESSAGE = originalBuildErrorMessage
  vi.unstubAllGlobals()

  await Promise.all(tempDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })))
})

describe("runner payload validation", () => {
  it("validates payload before checkout and writes checkout outputs", async () => {
    const directory = await createTempDirectory()
    const payloadPath = path.join(directory, "payload.json")
    const outputPath = path.join(directory, "github-output.txt")
    process.env.GITHUB_OUTPUT = outputPath

    const rawPayload = JSON.stringify(branchPayload)
    const payload = await validatePayload(rawPayload, payloadPath, signPayload(rawPayload))
    const output = await readFile(outputPath, "utf8")

    expect(payload.source_repo).toBe(branchPayload.source_repo)
    expect(await readFile(payloadPath, "utf8")).toContain(branchPayload.idempotency_key)
    expect(output).toContain(`source_repo=${branchPayload.source_repo}`)
    expect(output).toContain(`source_commit_sha=${branchPayload.source_commit_sha}`)
    expect(output).toContain(
      `raw_artifact_name=${generateArtifactName(branchPayload.idempotency_key, "build-artifacts-raw")}`
    )
  })

  it("rejects an invalid command before checkout outputs are created", async () => {
    const directory = await createTempDirectory()
    const payloadPath = path.join(directory, "payload.json")
    const outputPath = path.join(directory, "github-output.txt")
    process.env.GITHUB_OUTPUT = outputPath

    const rawPayload = JSON.stringify(invalidCommandPayload)

    await expect(validatePayload(rawPayload, payloadPath, signPayload(rawPayload))).rejects.toThrow()
    await expect(readFile(outputPath, "utf8")).rejects.toThrow()
  })

  it("rejects missing and tampered build payload signatures", async () => {
    const directory = await createTempDirectory()
    const payloadPath = path.join(directory, "payload.json")
    const rawPayload = JSON.stringify(branchPayload)

    await expect(validatePayload(rawPayload, payloadPath)).rejects.toThrow("BUILD_PAYLOAD_TIMESTAMP")
    await expect(
      validatePayload(rawPayload, payloadPath, signPayload(JSON.stringify({ ...branchPayload, run_id: "tampered" })))
    ).rejects.toThrow("Invalid build payload signature")
    await expect(readFile(payloadPath, "utf8")).rejects.toThrow()
  })

  it("workflow run-name includes only the run_id", async () => {
    const directory = await createTempDirectory()
    const outputPath = path.join(directory, "github-output.txt")
    process.env.GITHUB_OUTPUT = outputPath

    const rawPayload = JSON.stringify(branchPayload)
    await validatePayload(rawPayload, path.join(directory, "payload.json"), signPayload(rawPayload))

    const output = await readFile(outputPath, "utf8")
    const expectedRunName = generateRunName(branchPayload.run_id)
    const runNameLine = output.split("\n").find((line) => line.startsWith("run_name="))

    expect(expectedRunName).toBe(`Automation Run ${branchPayload.run_id}`)
    expect(runNameLine).toBe(`run_name=${expectedRunName}`)
  })
})

describe("runner build and manifest orchestration", () => {
  it("sends a failure callback after a successful build but failed finalize without exposing raw artifacts", async () => {
    const directory = await createTempDirectory()
    const sourceDirectory = path.join(directory, "source")
    const rawDirectory = path.join(directory, "raw")
    const finalDirectory = path.join(directory, "final")
    const outputDirectory = path.join(directory, "output")
    const payload = buildPayloadSchema.parse({
      ...branchPayload,
      source_resolved_identifier: "main",
      build_command: "node build.mjs",
      rewrite_version: true,
      artifact_name_template: "{channel_seq}",
    })
    const payloadPath = await writePayload(directory, payload)
    const jar = new JSZip()
    jar.file("plugin.yml", "name: Plugin\nversion: 1.0\n")
    const jarBytes = await jar.generateAsync({ type: "nodebuffer" })
    await mkdir(sourceDirectory)
    await writeFile(
      path.join(sourceDirectory, "build.mjs"),
      `import { mkdirSync, writeFileSync } from "node:fs"\nmkdirSync("target")\nwriteFileSync("target/plugin.jar", Buffer.from("${jarBytes.toString("base64")}", "base64"))\n`
    )

    await runBuild(payloadPath, sourceDirectory)
    await stageBuildArtifacts(payloadPath, sourceDirectory, rawDirectory)
    expect(await readFile(path.join(rawDirectory, "target", "plugin.jar"))).toEqual(jarBytes)
    await expect(generateManifest(payloadPath, rawDirectory, finalDirectory, outputDirectory)).rejects.toThrow(
      "channel_version_count"
    )
    await expect(readFile(path.join(outputDirectory, "manifest.json"))).rejects.toThrow()
    await expect(readFile(path.join(outputDirectory, "artifact-metadata.json"))).rejects.toThrow()
    await expect(readFile(path.join(finalDirectory, "target", "plugin.jar"))).rejects.toThrow()

    process.env.JOB_STATUS = "failure"
    process.env.BUILD_ERROR_MESSAGE = "Artifact version rewrite failed"
    process.env.AUTO_BUILD_CALLBACK_SECRET = "callback-secret"
    const fetchMock = vi.fn(
      async (_input: string | URL | Request, _init?: RequestInit) => new Response(null, { status: 204 })
    )
    vi.stubGlobal("fetch", fetchMock)

    await sendPostBuildCallback(payloadPath, outputDirectory)

    expect(fetchMock).toHaveBeenCalledOnce()
    expect(fetchMock.mock.calls[0]![0]).toBe(payload.callback_url)
    const callback = JSON.parse(String(fetchMock.mock.calls[0]![1]?.body))
    expect(callback).toMatchObject({
      conclusion: "failure",
      error_message: "Artifact version rewrite failed",
      manifest_artifact_name: generateArtifactName(payload.idempotency_key, "manifest"),
      artifact_names: [],
    })
    expect(callback.artifact_names).not.toContain(generateArtifactName(payload.idempotency_key, "build-artifacts-raw"))
  })

  it("reports a rewritten artifact path and produces no GitHub success outputs on rewrite failure", async () => {
    const directory = await createTempDirectory()
    const rawDirectory = path.join(directory, "raw")
    const payload = buildPayloadSchema.parse({
      ...branchPayload,
      source_resolved_identifier: "main",
      rewrite_version: true,
      name_template: "Display Name",
    })
    const payloadPath = await writePayload(directory, payload)
    const jar = new JSZip()
    jar.file("plugin.yml", "version: 1.0")
    await mkdir(path.join(rawDirectory, "target"), { recursive: true })
    await writeFile(path.join(rawDirectory, "target", "plugin.jar"), await jar.generateAsync({ type: "nodebuffer" }))
    const outputPath = path.join(directory, "github-output.txt")
    process.env.GITHUB_OUTPUT = outputPath

    const result = await generateManifest(
      payloadPath,
      rawDirectory,
      path.join(directory, "final"),
      path.join(directory, "output")
    )
    expect(result.artifactPaths.map((file) => path.basename(file))).toEqual(["plugin-1.jar"])
    expect(await readFile(outputPath, "utf8")).toContain(`artifact_paths=${result.artifactPaths[0]}`)

    await expect(
      generateManifest(
        await writePayload(directory, { ...payload, artifact_name_template: "{channel_seq}" }),
        rawDirectory,
        path.join(directory, "failed-final"),
        path.join(directory, "failed-output")
      )
    ).rejects.toThrow("channel_version_count")
    await expect(readFile(path.join(directory, "failed-output", "manifest.json"))).rejects.toThrow()
  })
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
    const rawDirectory = path.join(directory, "artifact-source")
    const finalDirectory = path.join(directory, "artifact-final")
    const artifactDirectory = path.join(sourceDirectory, "target")
    const payload = buildPayloadSchema.parse(branchPayload)
    const payloadPath = await writePayload(directory, payload)
    const outputPath = path.join(directory, "github-output.txt")
    process.env.GITHUB_OUTPUT = outputPath

    await mkdir(artifactDirectory, { recursive: true })
    await writeFile(path.join(artifactDirectory, "plugin.jar"), "fake jar bytes")

    await stageBuildArtifacts(payloadPath, sourceDirectory, rawDirectory)
    const metadata = await generateManifest(payloadPath, rawDirectory, finalDirectory, outputDirectory)
    const manifest = runnerManifestSchema.parse(
      JSON.parse(await readFile(path.join(outputDirectory, "manifest.json"), "utf8"))
    )
    const output = await readFile(outputPath, "utf8")

    expect(metadata.manifestArtifactName).toBe(generateArtifactName(payload.idempotency_key, "manifest"))
    expect(metadata.buildArtifactName).toBe(generateArtifactName(payload.idempotency_key, "build-artifacts"))
    expect(metadata.artifactPaths).toHaveLength(1)
    expect(metadata.artifactPaths).toEqual([path.join(finalDirectory, "target", "plugin.jar")])
    expect(manifest.minecraft_versions).toBeUndefined()
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
