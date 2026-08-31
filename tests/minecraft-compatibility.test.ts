import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"

import JSZip from "jszip"
import { afterEach, describe, expect, it, vi } from "vitest"

import { scanMinecraftCompatibility } from "../src/minecraft-compatibility.js"
import { runnerManifestSchema } from "../src/schema.js"

const catalog = ["1.20", "1.20.1", "1.20.4", "1.20.5", "1.20.6", "1.21", "1.21.1", "26.1"]
const directories: string[] = []

async function createJar(name: string, files: Record<string, string>) {
  const directory = await mkdtemp(path.join(tmpdir(), "guizhan-ci-compatibility-"))
  directories.push(directory)
  const jar = new JSZip()
  for (const [filename, content] of Object.entries(files)) jar.file(filename, content)
  const jarPath = path.join(directory, name)
  await writeFile(jarPath, await jar.generateAsync({ type: "nodebuffer" }))
  return jarPath
}

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })))
})

describe("Minecraft compatibility scanning", () => {
  it("expands plugin API versions, honors YAML strings, and falls back from paper to plugin", async () => {
    await expect(
      scanMinecraftCompatibility([await createJar("two.jar", { "plugin.yml": "api-version: 1.20\n" })], catalog)
    ).resolves.toMatchObject({
      platforms: ["spigot"],
      minecraftVersions: ["1.20", "1.20.1", "1.20.4", "1.20.5", "1.20.6"],
    })
    await expect(
      scanMinecraftCompatibility([await createJar("quoted.jar", { "plugin.yml": 'api-version: "1.20.5"\n' })], catalog)
    ).resolves.toMatchObject({
      minecraftVersions: ["1.20.5", "1.20.6"],
    })
    await expect(
      scanMinecraftCompatibility(
        [await createJar("fallback.jar", { "paper-plugin.yml": "name: Paper\n", "plugin.yml": "api-version: 1.20\n" })],
        catalog
      )
    ).resolves.toMatchObject({
      platforms: ["paper"],
      minecraftVersions: ["1.20", "1.20.1", "1.20.4", "1.20.5", "1.20.6"],
    })
  })

  it("rejects malformed and invalid plugin descriptors without masking paper errors", async () => {
    for (const content of ["api-version: 1.20.1.2\n", "api-version: [1.20]\n", "api-version: [\n"]) {
      await expect(
        scanMinecraftCompatibility([await createJar("bad.jar", { "plugin.yml": content })], catalog)
      ).rejects.toThrow("Invalid plugin.yml")
    }
    await expect(
      scanMinecraftCompatibility(
        [
          await createJar("paper-bad.jar", {
            "paper-plugin.yml": "api-version: [\n",
            "plugin.yml": "api-version: 1.20\n",
          }),
        ],
        catalog
      )
    ).rejects.toThrow("Invalid paper-plugin.yml")
    await expect(
      scanMinecraftCompatibility([await createJar("future.jar", { "plugin.yml": "api-version: 1.30\n" })], catalog)
    ).rejects.toThrow("matched no canonical")
  })

  it("evaluates Forge and NeoForge Maven constraints including bare cross-family requirements", async () => {
    const forge = await createJar("forge.jar", {
      "META-INF/mods.toml":
        "# comment\n[[dependencies.example]]\nmodId = 'minecraft'\nversionRange = '[1.20,1.21)'\n[[dependencies.example]]\nmodId = 'other'\nversionRange = '[1.20,1.21)'\n",
    })
    await expect(scanMinecraftCompatibility([forge], catalog)).resolves.toMatchObject({
      platforms: ["forge"],
      minecraftVersions: ["1.20", "1.20.1", "1.20.4", "1.20.5", "1.20.6"],
    })
    await expect(
      scanMinecraftCompatibility(
        [
          await createJar("bare.jar", {
            "META-INF/mods.toml": '[[dependencies.example]]\nmodId = "minecraft"\nversionRange = "1.20"\n',
          }),
        ],
        catalog
      )
    ).resolves.toMatchObject({ minecraftVersions: catalog })
    await expect(
      scanMinecraftCompatibility(
        [
          await createJar("intersection.jar", {
            "META-INF/neoforge.mods.toml":
              '[[dependencies.example]]\nmodId = "minecraft"\nversionRange = "[1.20,1.21)"\ntype = "optional"\n[[dependencies.example]]\nmodId = "minecraft"\nversionRange = "[1.20.5,1.21)"\ntype = "required"\n',
          }),
        ],
        catalog
      )
    ).resolves.toMatchObject({ platforms: ["neoforge"], minecraftVersions: ["1.20.5", "1.20.6"] })
    await expect(
      scanMinecraftCompatibility(
        [
          await createJar("unsupported.jar", {
            "META-INF/neoforge.mods.toml":
              '[[dependencies.example]]\nmodId = "minecraft"\nversionRange = "[1.20,)"\ntype = "incompatible"\n',
          }),
        ],
        catalog
      )
    ).rejects.toThrow("unsupported minecraft dependency type")
  })

  it("treats NeoForge dependency types case-insensitively and rejects invalid values", async () => {
    for (const dependencyType of ["INCOMPATIBLE", "Discouraged", "unknown"]) {
      await expect(
        scanMinecraftCompatibility(
          [
            await createJar(`${dependencyType}.jar`, {
              "META-INF/neoforge.mods.toml": `[[dependencies.example]]\nmodId = "minecraft"\nversionRange = "[1.20,)"\ntype = "${dependencyType}"\n`,
            }),
          ],
          catalog
        )
      ).rejects.toThrow("unsupported minecraft dependency type")
    }
    await expect(
      scanMinecraftCompatibility(
        [
          await createJar("type-number.jar", {
            "META-INF/neoforge.mods.toml":
              '[[dependencies.example]]\nmodId = "minecraft"\nversionRange = "[1.20,)"\ntype = 1\n',
          }),
        ],
        catalog
      )
    ).rejects.toThrow("minecraft dependency type must be a string")
    for (const dependencyType of ["REQUIRED", "Optional"]) {
      await expect(
        scanMinecraftCompatibility(
          [
            await createJar(`${dependencyType}.jar`, {
              "META-INF/neoforge.mods.toml": `[[dependencies.example]]\nmodId = "minecraft"\nversionRange = "[1.20]"\ntype = "${dependencyType}"\n`,
            }),
          ],
          catalog
        )
      ).resolves.toMatchObject({ minecraftVersions: ["1.20"] })
    }
  })

  it("supports Maven boundaries, unions, malformed TOML, and unexpanded properties", async () => {
    await expect(
      scanMinecraftCompatibility(
        [
          await createJar("ranges.jar", {
            "META-INF/mods.toml": '[[dependencies.example]]\nmodId = "minecraft"\nversionRange = "(,1.20],[1.20.5,)"\n',
          }),
        ],
        catalog
      )
    ).resolves.toMatchObject({ minecraftVersions: ["1.20", "1.20.5", "1.20.6", "1.21", "1.21.1", "26.1"] })
    for (const content of [
      "[[dependencies.example]\nmodId = ",
      '[[dependencies.example]]\nmodId = "minecraft"\nversionRange = "${minecraft_version_range}"\n',
    ]) {
      await expect(
        scanMinecraftCompatibility([await createJar("bad-toml.jar", { "META-INF/mods.toml": content })], catalog)
      ).rejects.toThrow("Invalid META-INF/mods.toml")
    }
  })

  it("handles Maven exact, bounded, unbounded, and open-boundary ranges", async () => {
    const cases: Array<[string, string[]]> = [
      ["[1.20]", ["1.20"]],
      ["[1.20.5,1.21)", ["1.20.5", "1.20.6"]],
      ["[1.20,)", catalog],
      ["(,1.20.6]", ["1.20", "1.20.1", "1.20.4", "1.20.5", "1.20.6"]],
      ["(1.20,1.20.5]", ["1.20.1", "1.20.4", "1.20.5"]],
    ]
    for (const [range, minecraftVersions] of cases) {
      await expect(
        scanMinecraftCompatibility(
          [
            await createJar(`${range.replaceAll(/[^\w]/g, "-")}.jar`, {
              "META-INF/mods.toml": `[[dependencies.example]]\nmodId = "minecraft"\nversionRange = "${range}"\n`,
            }),
          ],
          catalog
        )
      ).resolves.toMatchObject({ minecraftVersions })
    }
  })

  it("evaluates Fabric semantics and keeps platforms independent from constraints", async () => {
    const fabric = await createJar("fabric.jar", {
      "fabric.mod.json": '\uFEFF{"depends":{"minecraft":[">=1.20 <1.21", "1.21.x"]}}',
    })
    await expect(scanMinecraftCompatibility([fabric], catalog)).resolves.toMatchObject({
      platforms: ["fabric"],
      minecraftVersions: ["1.20", "1.20.1", "1.20.4", "1.20.5", "1.20.6", "1.21", "1.21.1"],
    })
    await expect(
      scanMinecraftCompatibility([await createJar("no-dep.jar", { "fabric.mod.json": "{}" })], catalog)
    ).resolves.toEqual({
      hasRecognizedDescriptor: true,
      platforms: ["fabric"],
    })
    await expect(
      scanMinecraftCompatibility([await createJar("bad-json.jar", { "fabric.mod.json": "{" })], catalog)
    ).rejects.toThrow("Invalid fabric.mod.json")
  })

  it("supports every Fabric version expression form", async () => {
    const cases: Array<[string, string[]]> = [
      ["1.20.4", ["1.20.4"]],
      ["~1.20", ["1.20", "1.20.1", "1.20.4", "1.20.5", "1.20.6"]],
      ["^1.20", ["1.20", "1.20.1", "1.20.4", "1.20.5", "1.20.6", "1.21", "1.21.1"]],
      ["1.20.x", ["1.20", "1.20.1", "1.20.4", "1.20.5", "1.20.6"]],
      ["1.20.*", ["1.20", "1.20.1", "1.20.4", "1.20.5", "1.20.6"]],
      ["*", catalog],
    ]
    for (const [constraint, minecraftVersions] of cases) {
      await expect(
        scanMinecraftCompatibility(
          [
            await createJar(`${constraint.replaceAll(/[^\w]/g, "-")}.jar`, {
              "fabric.mod.json": JSON.stringify({ depends: { minecraft: constraint } }),
            }),
          ],
          catalog
        )
      ).resolves.toMatchObject({ minecraftVersions })
    }
  })

  it("evaluates recursive Quilt constraints and intersects Minecraft dependency objects", async () => {
    const quilt = await createJar("quilt.jar", {
      "quilt.mod.json": JSON.stringify({
        quilt_loader: {
          depends: [
            { id: "minecraft", versions: { any: ["=1.20.4", { all: ["^1.21", ">=1.21.1"] }] } },
            { id: "minecraft", versions: ["1.20.x", "^1.21"] },
          ],
        },
      }),
    })
    await expect(scanMinecraftCompatibility([quilt], catalog)).resolves.toMatchObject({
      minecraftVersions: ["1.20.4", "1.21.1"],
    })
    await expect(
      scanMinecraftCompatibility(
        [
          await createJar("quilt-bad.jar", {
            "quilt.mod.json": '{"quilt_loader":{"depends":[{"id":"minecraft","versions":{}}]}}',
          }),
        ],
        catalog
      )
    ).rejects.toThrow("Invalid quilt.mod.json")
  })

  it("defaults missing Quilt versions and rejects invalid Quilt constraint objects", async () => {
    await expect(
      scanMinecraftCompatibility(
        [
          await createJar("quilt-default.jar", {
            "quilt.mod.json": '{"quilt_loader":{"depends":[{"id":"minecraft"}]}}',
          }),
        ],
        catalog
      )
    ).resolves.toMatchObject({ minecraftVersions: catalog })
    for (const versions of [
      null, // explicit null is invalid; only a missing field defaults to "*"
      { any: [] },
      { all: [] },
      { any: ["*"], all: ["*"] },
      { any: "*" },
      { all: "*" },
      { unknown: ["*"] },
    ]) {
      await expect(
        scanMinecraftCompatibility(
          [
            await createJar("quilt-invalid.jar", {
              "quilt.mod.json": JSON.stringify({ quilt_loader: { depends: [{ id: "minecraft", versions }] } }),
            }),
          ],
          catalog
        )
      ).rejects.toThrow("Invalid quilt.mod.json")
    }
  })

  it("maps every descriptor to its frozen platform and manifests accept all schema platforms", async () => {
    const jar = await createJar("all-platforms.jar", {
      "paper-plugin.yml": "api-version: 1.20\n",
      "plugin.yml": "api-version: 1.20\n",
      "META-INF/mods.toml": '[[dependencies.example]]\nmodId = "minecraft"\nversionRange = "[1.20]"\n',
      "META-INF/neoforge.mods.toml": '[[dependencies.example]]\nmodId = "minecraft"\nversionRange = "[1.20]"\n',
      "fabric.mod.json": '{"depends":{"minecraft":"1.20"}}',
      "quilt.mod.json": '{"quilt_loader":{"depends":[{"id":"minecraft","versions":"=1.20"}]}}',
    })
    await expect(scanMinecraftCompatibility([jar], catalog)).resolves.toMatchObject({
      platforms: ["paper", "forge", "neoforge", "fabric", "quilt"],
      minecraftVersions: ["1.20", "1.20.1", "1.20.4", "1.20.5", "1.20.6"],
    })
    expect(
      runnerManifestSchema.safeParse({
        run_id: "runbranch001",
        project_id: "project001",
        channel: "stable",
        source_mode: "branch",
        source_identifier: "main",
        source_commit_sha: "abcdef1234567890abcdef1234567890abcdef12",
        build_profile: "default",
        version: "1-0-0",
        name: "Example",
        platforms: ["forge", "neoforge", "fabric", "quilt"],
        artifacts: [
          {
            name: "example.jar",
            url: "https://example.com/example.jar",
            sha1: "0123456789abcdef0123456789abcdef01234567",
            sha256: "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
            size: 1,
          },
        ],
      }).success
    ).toBe(true)
  })

  it("unions descriptor-bearing jars, suppresses plugin.yml under paper, skips sources, and warns when none exist", async () => {
    const warning = vi.spyOn(console, "warn").mockImplementation(() => undefined)
    const paper = await createJar("paper.jar", {
      "paper-plugin.yml": "api-version: 1.20\n",
      "plugin.yml": "api-version: 1.20\n",
    })
    const mod = await createJar("mod.jar", {
      "META-INF/mods.toml": '[[dependencies.example]]\nmodId = "minecraft"\nversionRange = "[1.21]"\n',
      "fabric.mod.json": '{"depends":{"minecraft":"1.20.4"}}',
    })
    const sources = await createJar("mod-sources.jar", {
      "META-INF/neoforge.mods.toml": '[[dependencies.example]]\nmodId = "minecraft"\nversionRange = "[1.20]"\n',
    })
    await expect(scanMinecraftCompatibility([sources, paper, mod], catalog)).resolves.toEqual({
      hasRecognizedDescriptor: true,
      platforms: ["paper", "forge", "fabric"],
      minecraftVersions: ["1.20", "1.20.1", "1.20.4", "1.20.5", "1.20.6", "1.21"],
    })
    const result = await scanMinecraftCompatibility(
      [await createJar("library.jar", { "META-INF/MANIFEST.MF": "Manifest-Version: 1.0\n" })],
      catalog
    )
    if (!result.hasRecognizedDescriptor)
      console.warn("No supported Minecraft compatibility descriptor found in build artifacts")
    expect(warning).toHaveBeenCalled()
  })
})
