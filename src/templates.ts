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

export function renderTemplate(template: string, values: TemplateValues): string {
  return template.replace(/\{([^{}]+)\}/g, (token, name: string) => {
    if (!(templateVariables as readonly string[]).includes(name)) {
      throw new Error(`Unknown template variable: ${token}`)
    }
    return values[name as keyof TemplateValues]
  })
}
