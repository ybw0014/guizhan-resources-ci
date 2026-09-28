export const BUILD_DIRECTORY_SEGMENT_REGEX = /^[A-Za-z0-9_.-]+$/
export const BUILD_DIRECTORY_SEGMENT_MAX_LENGTH = 255
export const FORBIDDEN_BUILD_DIRECTORY_SEGMENTS = new Set([".", "..", ".git"])
export const ARTIFACT_SEARCH_PATHS = ["target", "build/libs"]
export const RAW_ARTIFACT_SUFFIX = "build-artifacts-raw"
export const FINAL_ARTIFACT_SUFFIX = "build-artifacts"
export const ARTIFACT_NAME_TEMPLATE_MAX_LENGTH = 256
export const ARTIFACT_NAME_MAX_LENGTH = 128
export const ARTIFACT_NAME_SAFE_REGEX = /^[A-Za-z0-9._-]+$/
export const ARTIFACT_FILE_NAME_REGEX = /^[a-zA-Z0-9](?:[a-zA-Z0-9_-]|\.(?!\.))*[a-zA-Z0-9]\.[a-zA-Z0-9]+$/
export const WINDOWS_DEVICE_NAME_REGEX = /^(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\.|$)/i
export const ARTIFACT_TEMPLATE_TOKEN_REGEX = /(?:[A-Za-z0-9._-]+|\{([a-z_]+)\})/y
export const ARTIFACT_RUN_VARIABLES = ["version", "channel_seq", "commit_sha"] as const
export const ARTIFACT_FILENAME_VARIABLES = [
  "identifier",
  "mode",
  "commit_sha",
  "repo",
  "profile",
  "channel_seq",
  "jar_version",
  "commit_message",
  "version",
  "basename",
] as const
export const JAR_METADATA_PATHS = [
  "plugin.yml",
  "paper-plugin.yml",
  "fabric.mod.json",
  "quilt.mod.json",
  "META-INF/mods.toml",
  "META-INF/neoforge.mods.toml",
] as const
export const JAR_VERSION_PRIORITY = [
  "paper-plugin.yml",
  "plugin.yml",
  "fabric.mod.json",
  "quilt.mod.json",
  "META-INF/mods.toml",
  "META-INF/neoforge.mods.toml",
] as const
export const JAR_SIGNATURE_MARKER_REGEX = /^META-INF\/(?:[^/]+\.(?:SF|RSA|DSA|EC)|SIG-[^/]*)$/i
export const JAR_MANIFEST_PATH = "META-INF/MANIFEST.MF"
