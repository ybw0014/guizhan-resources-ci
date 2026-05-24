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

function parseSdkmanCommand(command: string): ["install" | "use", "java" | "maven" | "gradle", string?] {
  const match = command
    .trim()
    .match(/^sdk\s+(install|use)\s+(java|maven|gradle)(?:\s+([a-zA-Z0-9._+-]+))?$/)

  if (!match) {
    throw new Error("SDKMAN command must be a single sdk install/use command for java, maven, or gradle")
  }

  return [match[1] as "install" | "use", match[2] as "java" | "maven" | "gradle", match[3]]
}

export async function runSdkmanCustom(command: string): Promise<void> {
  const [action, candidate, version] = parseSdkmanCommand(command)
  const sdkmanInit = "${SDKMAN_DIR:-$HOME/.sdkman}/bin/sdkman-init.sh"
  const setupCommand = `source "${sdkmanInit}" && sdk "$@"`

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
