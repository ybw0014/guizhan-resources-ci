import { spawn } from "node:child_process"

import { BuildPayload } from "./schema.js"

export type ToolchainConfig = {
  javaVersion: string
  mavenVersion: string
  sdkmanCustom?: string
}

export function createToolchainConfig(payload: BuildPayload): ToolchainConfig {
  return {
    javaVersion: payload.java_version,
    mavenVersion: payload.maven_version,
    sdkmanCustom: payload.sdkman_custom,
  }
}

export async function runSdkmanCustom(command: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn("bash", ["-lc", command], {
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
