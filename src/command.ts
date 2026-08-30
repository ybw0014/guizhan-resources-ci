import { spawn } from "node:child_process"
import { accessSync, chmodSync, constants, statSync } from "node:fs"
import { resolve } from "node:path"

import { BuildPayload } from "./schema.js"

const BLOCKED_BUILD_ENV_KEYS = new Set([
  "AUTO_BUILD_CALLBACK_SECRET",
  "AUTO_BUILD_GITHUB_TOKEN",
  "GITHUB_TOKEN",
  "ACTIONS_RUNTIME_TOKEN",
  "ACTIONS_ID_TOKEN_REQUEST_TOKEN",
  "GITHUB_ENV",
  "GITHUB_OUTPUT",
  "GITHUB_PATH",
  "GITHUB_STEP_SUMMARY",
])

export function sanitizeBuildEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const sanitized: NodeJS.ProcessEnv = {}

  for (const [key, value] of Object.entries(env)) {
    if (value === undefined || BLOCKED_BUILD_ENV_KEYS.has(key)) {
      continue
    }

    sanitized[key] = value
  }

  return sanitized
}

export function splitBuildCommand(command: string): [string, ...string[]] {
  const parts: string[] = []
  let current = ""
  let quote: '"' | "'" | undefined

  for (const char of command.trim()) {
    if ((char === '"' || char === "'") && quote === undefined) {
      quote = char
      continue
    }

    if (char === quote) {
      quote = undefined
      continue
    }

    if (/\s/.test(char) && quote === undefined) {
      if (current) {
        parts.push(current)
        current = ""
      }
      continue
    }

    current += char
  }

  if (quote !== undefined) {
    throw new Error("Build command contains an unterminated quote")
  }

  if (current) {
    parts.push(current)
  }

  if (parts.length === 0) {
    throw new Error("Build command is empty")
  }

  return parts as [string, ...string[]]
}

/**
 * Ensure a relative-path build command (e.g. ./gradlew) is executable.
 * Source repositories may commit wrapper scripts without the executable bit,
 * and spawn() with shell:false fails with EACCES in that case.
 */
export function ensureExecutable(command: string, cwd: string): void {
  if (!command.startsWith("./") && !command.startsWith("../")) return

  const path = resolve(cwd, command)

  try {
    accessSync(path, constants.X_OK)
    return
  } catch {
    // Not executable (or missing) — attempt to fix below
  }

  try {
    const stat = statSync(path)
    if (stat.isFile()) {
      console.log(`Adding executable permission to ${command}`)
      chmodSync(path, stat.mode | 0o111)
    }
  } catch {
    // Let spawn() surface the original error (e.g. ENOENT)
  }
}

export async function executeBuildCommand(
  payload: BuildPayload,
  cwd: string,
  env: NodeJS.ProcessEnv = process.env
): Promise<void> {
  const [command, ...args] = splitBuildCommand(payload.build_command)

  ensureExecutable(command, cwd)

  console.log(`Executing build command: ${payload.build_command}`)

  await new Promise<void>((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      env: sanitizeBuildEnv(env),
      shell: false,
      stdio: "inherit",
    })

    child.on("error", reject)
    child.on("exit", (code) => {
      if (code === 0) {
        resolve()
        return
      }

      reject(new Error(`Build command failed with exit code ${code ?? "unknown"}`))
    })
  })
}
