import { spawn } from "node:child_process"

import { BuildPayload } from "./schema.js"

export type ToolchainConfig = {
  javaVersion: string
  mavenVersion: string
  pnpmVersion: string
  sdkmanCustom?: string
}

export function createToolchainConfig(payload: BuildPayload): ToolchainConfig {
  return {
    javaVersion: payload.java_version,
    mavenVersion: payload.maven_version,
    pnpmVersion: payload.pnpm_version,
    sdkmanCustom: payload.sdkman_custom,
  }
}

export function parseSdkmanCommand(command: string): ["install" | "use", "java" | "maven" | "gradle", string?] {
  const match = command
    .trim()
    .match(/^sdk\s+(install|use)\s+(java|maven|gradle)(?:\s+([a-zA-Z0-9._+-]+))?$/)

  if (!match) {
    throw new Error("SDKMAN command must be a single sdk install/use command for java, maven, or gradle")
  }

  return [match[1] as "install" | "use", match[2] as "java" | "maven" | "gradle", match[3]]
}

export function createSdkmanSetupCommand() {
  return [
    "set -o pipefail",
    "",
    'sdkman_dir="${SDKMAN_DIR:-$HOME/.sdkman}"',
    'sdkman_init="$sdkman_dir/bin/sdkman-init.sh"',
    "",
    'if [[ ! -f "$sdkman_init" ]]; then',
    '  curl -fsSL "https://get.sdkman.io?ci=true&rcupdate=false" | bash || exit $?',
    "fi",
    "",
    'source "$sdkman_init" || exit $?',
    "",
    'action="$1"',
    'candidate="$2"',
    'version="${3:-}"',
    "",
    'if [[ "$action" == "use" && -n "$version" ]]; then',
    '  if [[ -z "${GITHUB_ENV:-}" || -z "${GITHUB_PATH:-}" ]]; then',
    '    echo "GITHUB_ENV and GITHUB_PATH must be set to persist SDKMAN toolchain selection" >&2',
    "    exit 1",
    "  fi",
    "",
    '  sdk install "$candidate" "$version" || exit $?',
    '  sdk use "$candidate" "$version" || exit $?',
    "",
    '  candidate_home="$sdkman_dir/candidates/$candidate/$version"',
    '  upper_candidate="$(printf %s "$candidate" | tr "[:lower:]" "[:upper:]")"',
    "  printf '%s_HOME=%s\\n' \"$upper_candidate\" \"$candidate_home\" >> \"$GITHUB_ENV\"",
    "  printf '%s/bin\\n' \"$candidate_home\" >> \"$GITHUB_PATH\"",
    'elif [[ -n "$version" ]]; then',
    '  sdk "$action" "$candidate" "$version"',
    "else",
    '  sdk "$action" "$candidate"',
    "fi",
  ].join("\n")
}

export async function runSdkmanCustom(command: string): Promise<void> {
  const [action, candidate, version] = parseSdkmanCommand(command)
  const setupCommand = createSdkmanSetupCommand()

  await new Promise<void>((resolve, reject) => {
    const child = spawn("bash", ["-lc", setupCommand, "sdkman", action, candidate, ...(version ? [version] : [])], {
      stdio: "inherit",
    })

    child.on("error", reject)
    child.on("exit", (code) => {
      if (code === 0) {
        resolve()
        return
      }

      reject(new Error(`SDKMAN custom command failed with exit code ${code ?? "unknown"}`))
    })
  })
}

async function main() {
  const command = process.env.SDKMAN_CUSTOM

  if (!command) {
    return
  }

  await runSdkmanCustom(command)
}

if (import.meta.url === `file://${process.argv[1]}`) {
  await main()
}
