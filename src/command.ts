import { spawn } from "node:child_process"
import { accessSync, chmodSync, constants, readFileSync, statSync, writeFileSync } from "node:fs"
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
 * Prepare a relative-path build command (e.g. ./gradlew) for direct spawn:
 * - add the executable bit if missing (repos may commit wrappers without it, spawn fails with EACCES)
 * - normalize CRLF line endings on shebang scripts (CRLF breaks interpreter resolution, spawn fails with ENOENT)
 */
export function prepareCommandScript(command: string, cwd: string): void {
  if (!command.startsWith("./") && !command.startsWith("../")) return

  const path = resolve(cwd, command)

  let stat
  try {
    stat = statSync(path)
  } catch {
    return // Let spawn() surface the original error (e.g. ENOENT)
  }
  if (!stat.isFile()) return

  try {
    accessSync(path, constants.X_OK)
  } catch {
    console.log(`Adding executable permission to ${command}`)
    chmodSync(path, stat.mode | 0o111)
  }

  const content = readFileSync(path)
  if (content.subarray(0, 2).toString() === "#!" && content.includes("\r\n")) {
    console.log(`Normalizing CRLF line endings in ${command}`)
    writeFileSync(path, content.toString("utf8").replace(/\r\n/g, "\n"))
  }
}

export async function executeBuildCommand(
  payload: BuildPayload,
  cwd: string,
  env: NodeJS.ProcessEnv = process.env
): Promise<void> {
  const [command, ...args] = splitBuildCommand(payload.build_command)

  prepareCommandScript(command, cwd)

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
