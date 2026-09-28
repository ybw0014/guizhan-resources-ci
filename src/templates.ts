import { ARTIFACT_FILENAME_VARIABLES, ARTIFACT_RUN_VARIABLES, ARTIFACT_TEMPLATE_TOKEN_REGEX } from "./config.js"
import { BuildPayload } from "./schema.js"

const templateVariables = [
  "identifier",
  "mode",
  "commit_sha",
  "repo",
  "profile",
  "channel_seq",
  "jar_version",
  "commit_message",
] as const

export type TemplateValues = Record<(typeof templateVariables)[number], string>
export type FilenameTemplateValues = Record<(typeof ARTIFACT_FILENAME_VARIABLES)[number], string>

export function createTemplateValues(payload: BuildPayload, jarVersion?: string): TemplateValues {
  return {
    identifier: payload.source_resolved_identifier ?? payload.source_identifier,
    mode: payload.source_mode,
    commit_sha: payload.source_commit_sha.slice(0, 7),
    repo: payload.source_repo,
    profile: payload.build_profile,
    channel_seq: payload.channel_version_count === undefined ? "" : String(payload.channel_version_count + 1),
    jar_version: jarVersion ?? "",
    commit_message: payload.source_commit_message ?? "",
  }
}

export function renderTemplate(template: string, values: TemplateValues | FilenameTemplateValues): string {
  const allowed = "basename" in values ? ARTIFACT_FILENAME_VARIABLES : templateVariables
  return template.replace(/\{([^{}]+)\}/g, (token, name: string) => {
    assertKnownVariable(name, allowed, token)
    return values[name as keyof TemplateValues]
  })
}

function assertKnownVariable(name: string, allowed: readonly string[], token: string) {
  if (!allowed.includes(name)) throw new Error(`Unknown template variable: ${token}`)
}

export function validateFilenameTemplate(template: string) {
  const variables: string[] = []
  let end = 0
  while (end < template.length) {
    ARTIFACT_TEMPLATE_TOKEN_REGEX.lastIndex = end
    const match = ARTIFACT_TEMPLATE_TOKEN_REGEX.exec(template)
    if (!match) throw new Error(`Invalid artifact filename template at position ${end}`)
    if (match[1]) {
      assertKnownVariable(match[1], ARTIFACT_FILENAME_VARIABLES, `{${match[1]}}`)
      variables.push(match[1])
    }
    end = ARTIFACT_TEMPLATE_TOKEN_REGEX.lastIndex
  }
  if (!variables.some((variable) => (ARTIFACT_RUN_VARIABLES as readonly string[]).includes(variable))) {
    throw new Error("Artifact filename template requires a run identifier")
  }
}
