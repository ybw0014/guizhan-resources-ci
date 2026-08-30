import { execFile } from "node:child_process"
import { readFile, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { promisify } from "node:util"

import { afterEach, beforeEach, describe, expect, it } from "vitest"

import { createSdkmanSetupCommand, parseSdkmanCommand } from "../src/toolchain.js"

const execFileAsync = promisify(execFile)

let testDirectory: string

beforeEach(async () => {
  testDirectory = await mkdtemp(path.join(tmpdir(), "guizhan-resources-toolchain-test-"))
})

afterEach(async () => {
  await rm(testDirectory, { force: true, recursive: true })
})

describe("parseSdkmanCommand", () => {
  it.each([
    ["sdk install java 21.0.6-tem", ["install", "java", "21.0.6-tem"]],
    [" sdk use maven 3.9.9 ", ["use", "maven", "3.9.9"]],
    ["sdk use gradle", ["use", "gradle", undefined]],
  ] as const)("accepts %s", (command, expected) => {
    expect(parseSdkmanCommand(command)).toEqual(expected)
  })

  it.each(["sdk list java", "sdk use kotlin 2.1.0", "sdk use java 21; echo unsafe", "sdk install java 21 extra"])(
    "rejects %s",
    (command) => {
      expect(() => parseSdkmanCommand(command)).toThrow(
        "SDKMAN command must be a single sdk install/use command for java, maven, or gradle"
      )
    }
  )
})

describe("createSdkmanSetupCommand", () => {
  it("installs and persists a versioned use selection", async () => {
    const { callsPath, githubEnvPath, githubPathPath, sdkmanDirectory } = await createFakeSdkman()

    await runSetupCommand(["use", "java", "21.0.6-tem"], {
      GITHUB_ENV: githubEnvPath,
      GITHUB_PATH: githubPathPath,
      SDKMAN_DIR: sdkmanDirectory,
    })

    expect(await readFile(callsPath, "utf8")).toBe("install java 21.0.6-tem\nuse java 21.0.6-tem\n")
    expect(await readFile(githubEnvPath, "utf8")).toBe(`JAVA_HOME=${sdkmanDirectory}/candidates/java/21.0.6-tem\n`)
    expect(await readFile(githubEnvPath, "utf8")).not.toContain("PATH=")
    expect(await readFile(githubPathPath, "utf8")).toBe(`${sdkmanDirectory}/candidates/java/21.0.6-tem/bin\n`)
    expect(await readFile(githubPathPath, "utf8")).not.toContain("$PATH")
  })

  it.each([
    ["GITHUB_ENV", "GITHUB_PATH"],
    ["GITHUB_PATH", "GITHUB_ENV"],
  ])("fails versioned use when %s is missing", async (missingVariable, presentVariable) => {
    const { callsPath, githubEnvPath, githubPathPath, sdkmanDirectory } = await createFakeSdkman()
    const environment = {
      GITHUB_ENV: "",
      GITHUB_PATH: "",
      SDKMAN_DIR: sdkmanDirectory,
      [presentVariable]: presentVariable === "GITHUB_ENV" ? githubEnvPath : githubPathPath,
    }

    await expect(runSetupCommand(["use", "java", "21.0.6-tem"], environment)).rejects.toThrow()
    expect(await readFile(callsPath, "utf8")).toBe("")
    expect(await readFile(githubEnvPath, "utf8")).toBe("")
    expect(await readFile(githubPathPath, "utf8")).toBe("")
    expect(missingVariable).not.toBe(presentVariable)
  })

  it("fails when SDKMAN install fails without invoking use", async () => {
    const { callsPath, githubEnvPath, githubPathPath, sdkmanDirectory, sdkmanFailAction } = await createFakeSdkman({
      failAction: "install",
    })

    await expect(
      runSetupCommand(["use", "java", "21.0.6-tem"], {
        GITHUB_ENV: githubEnvPath,
        GITHUB_PATH: githubPathPath,
        SDKMAN_DIR: sdkmanDirectory,
        SDKMAN_FAIL_ACTION: sdkmanFailAction,
      })
    ).rejects.toThrow()
    expect(await readFile(callsPath, "utf8")).toBe("install java 21.0.6-tem\n")
    expect(await readFile(githubEnvPath, "utf8")).toBe("")
    expect(await readFile(githubPathPath, "utf8")).toBe("")
  })

  it("keeps unversioned use commands as their original invocation", async () => {
    const { callsPath, sdkmanDirectory } = await createFakeSdkman()

    await runSetupCommand(["use", "maven"], { SDKMAN_DIR: sdkmanDirectory })

    expect(await readFile(callsPath, "utf8")).toBe("use maven\n")
  })

  it("keeps install commands as install commands", async () => {
    const { callsPath, sdkmanDirectory } = await createFakeSdkman()

    await runSetupCommand(["install", "gradle", "8.12"], { SDKMAN_DIR: sdkmanDirectory })

    expect(await readFile(callsPath, "utf8")).toBe("install gradle 8.12\n")
  })

  it("installs SDKMAN when its init script is missing", () => {
    const command = createSdkmanSetupCommand()

    expect(command).toContain("set -o pipefail")
    expect(command).toContain('if [[ ! -f "$sdkman_init" ]]; then')
    expect(command).toContain('curl -fsSL "https://get.sdkman.io?ci=true&rcupdate=false" | bash')
    expect(command).toContain('source "$sdkman_init"')
  })
})

async function createFakeSdkman(options: { failAction?: "install" | "use" } = {}) {
  const sdkmanDirectory = path.join(testDirectory, "sdkman")
  const callsPath = path.join(testDirectory, "calls.log")
  const githubEnvPath = path.join(testDirectory, "github.env")
  const githubPathPath = path.join(testDirectory, "github.path")
  const initPath = path.join(sdkmanDirectory, "bin", "sdkman-init.sh")

  await mkdir(path.dirname(initPath), { recursive: true })
  await writeFile(
    initPath,
    'sdk() {\n  printf "%s\\n" "$*" >> "$SDKMAN_CALLS"\n  if [[ -n "${SDKMAN_FAIL_ACTION:-}" && "$1" == "${SDKMAN_FAIL_ACTION}" ]]; then\n    return 1\n  fi\n  return 0\n}\n'
  )
  await writeFile(callsPath, "")
  await writeFile(githubEnvPath, "")
  await writeFile(githubPathPath, "")

  return { callsPath, githubEnvPath, githubPathPath, sdkmanDirectory, sdkmanFailAction: options.failAction ?? "" }
}

async function runSetupCommand(args: string[], environment: Record<string, string>) {
  await execFileAsync("bash", ["-c", createSdkmanSetupCommand(), "sdkman", ...args], {
    env: { ...process.env, ...environment, SDKMAN_CALLS: path.join(testDirectory, "calls.log") },
  })
}
