import { spawn } from "node:child_process"

import { BuildPayload } from "./schema.js"

const BLOCKED_BUILD_ENV_KEYS = new Set([
  "AUTO_BUILD_CALLBACK_SECRET",
  "AUTO_BUILD_GITHUB_TOKEN",
  "GITHUB_TOKEN",
  "ACTIONS_RUNTIME_TOKEN",
  "ACTIONS_ID_TOKEN_REQUEST_TOKEN",
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

export async function executeBuildCommand(
  payload: BuildPayload,
  cwd: string,
  env: NodeJS.ProcessEnv = process.env
): Promise<void> {
  const [command, ...args] = splitBuildCommand(payload.build_command)

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
