import * as z from "zod/v4"

const alphanumericRegex = /^[a-zA-Z0-9]+$/
const githubRepoRegex = /^[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+$/
const httpProtocolRegex = /^https?$/
const urlSafeRegex = /^[a-zA-Z0-9_-]+$/
const fileNameRegex = /^[^\\/:*?"<>|]+$/
const hexRegex = /^[a-fA-F0-9]+$/

const sourceModeSchema = z.enum(["branch", "tag", "release"])
const platformSchema = z.enum(["bukkit", "paper", "spigot", "folia"])

const buildCommandSchema = z
  .string()
  .min(1)
  .max(1000)
  // Keep runner commands single-step and reject shell operators or secret-export patterns.
  .refine((value) => !/[\n\r;|&$`]/.test(value) && !/\b(?:eval|export)\b/i.test(value), {
    message: "Build command contains disallowed shell syntax",
  })

export const buildPayloadSchema = z.object({
  schema_version: z.literal(1),
  run_id: z.string().min(1).max(32).regex(alphanumericRegex),
  profile_id: z.string().min(1).max(32).regex(alphanumericRegex),
  project_id: z.string().min(1).max(32).regex(alphanumericRegex),
  channel: z.string().min(1).max(64),
  idempotency_key: z.string().min(1).max(128),
  source_repo: z.string().min(1).max(255).regex(githubRepoRegex),
  source_mode: sourceModeSchema,
  source_identifier: z.string().min(1).max(255),
  source_commit_sha: z.string().min(7).max(64),
  build_profile: z.string().min(1).max(64),
  runner_repo: z.string().min(1).max(255).regex(githubRepoRegex),
  runner_workflow: z.string().min(1).max(255),
  build_command: buildCommandSchema,
  java_version: z.string().min(1).max(32),
  maven_version: z.string().min(1).max(32),
  sdkman_custom: z.string().max(1000).optional(),
  callback_url: z.url({ protocol: httpProtocolRegex }).max(2048),
  artifact_retention: z.number().int().min(1).default(7),
})

export const callbackPayloadSchema = z.object({
  schema_version: z.literal(1),
  run_id: z.string().min(1).max(32).regex(alphanumericRegex),
  profile_id: z.string().min(1).max(32).regex(alphanumericRegex),
  project_id: z.string().min(1).max(32).regex(alphanumericRegex),
  idempotency_key: z.string().min(1).max(128),
  runner_repo: z.string().min(1).max(255).regex(githubRepoRegex),
  runner_workflow: z.string().min(1).max(255),
  workflow_run_id: z.number().int().min(1),
  workflow_attempt: z.number().int().min(1),
  conclusion: z.enum(["success", "failure", "cancelled"]),
  manifest_artifact_name: z.string().min(1).max(128).regex(fileNameRegex),
  manifest_artifact_id: z.number().int().min(1).optional(),
  artifact_names: z.array(z.string().min(1).max(128).regex(fileNameRegex)),
  error_message: z.string().max(1000).optional(),
})

const artifactSchema = z.object({
  name: z.string().min(1).max(128).regex(fileNameRegex),
  url: z.url({ protocol: httpProtocolRegex }).max(2048),
  sha1: z.string().length(40).regex(hexRegex),
  sha256: z.string().length(64).regex(hexRegex),
  size: z.number().int().min(0),
})

export const runnerManifestSchema = z.object({
  run_id: z.string().min(1).max(32).regex(alphanumericRegex),
  project_id: z.string().min(1).max(32).regex(alphanumericRegex),
  channel: z.string().min(1).max(64),
  source_mode: sourceModeSchema,
  source_identifier: z.string().min(1).max(255),
  source_commit_sha: z.string().min(7).max(64),
  build_profile: z.string().min(1).max(64),
  version: z.string().min(1).max(32).regex(urlSafeRegex),
  name: z.string().min(1).max(64),
  changelog: z.string().max(1000).optional(),
  minecraft_versions: z.array(z.string()).min(1),
  platforms: z.array(platformSchema).min(1).max(10),
  dependencies: z.array(z.unknown()).optional(),
  artifacts: z.array(artifactSchema).min(1),
})

export type BuildPayload = z.infer<typeof buildPayloadSchema>
export type CallbackPayload = z.infer<typeof callbackPayloadSchema>
export type RunnerManifest = z.infer<typeof runnerManifestSchema>
