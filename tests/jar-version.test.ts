import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"

import JSZip from "jszip"
import YAML from "yaml"
import { afterEach, expect, it } from "vitest"

import { assertRewrittenVersion, assertUnsignedJar, inspectJar, rewriteJar } from "../src/jar-version.js"

const directories: string[] = []
async function fixture(files: Record<string, string | Buffer>) {
  const directory = await mkdtemp(path.join(tmpdir(), "jar-version-"))
  directories.push(directory)
  const file = path.join(directory, "plugin.jar")
  const jar = new JSZip()
  for (const [name, content] of Object.entries(files)) jar.file(name, content)
  const original = await jar.generateAsync({ type: "nodebuffer" })
  await writeFile(file, original)
  return { file, original }
}

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })))
})

const metadata = {
  "plugin.yml": "name: Plugin\nversion: 1.0 # old\ndependencies: [Another]\n",
  "paper-plugin.yml": "name: Plugin\nversion: '1.0'\n",
  "fabric.mod.json": JSON.stringify({ id: "plugin", version: "1.0", depends: { minecraft: "1.21" } }),
  "quilt.mod.json": JSON.stringify({ quilt_loader: { id: "plugin", version: "1.0", depends: { minecraft: "1.21" } } }),
  "META-INF/mods.toml":
    '[[mods]]\nmodId = "plugin"\nversion = "${file.jarVersion}"\n[[mods]]\nmodId = "other"\nversion = "1.0"\n',
  "META-INF/neoforge.mods.toml": '[[mods]]\nmodId = "plugin"\nversion = "1.0"\n',
}

it.each(Object.entries(metadata))("rewrites %s using parser round trips", async (name, content) => {
  const { file } = await fixture({ [name]: content, "unrelated.txt": "unaltered" })
  const inspection = await inspectJar(file)
  expect(inspection.entries).toHaveLength(1)
  const result = await JSZip.loadAsync(await rewriteJar(inspection, file, 'Release: "Beta" # 1'))
  assertRewrittenVersion(name as keyof typeof metadata, await result.file(name)!.async("string"), 'Release: "Beta" # 1')
  expect(await result.file("unrelated.txt")!.async("string")).toBe("unaltered")
})

it("rewrites every descriptor and leaves nested JAR and manifest unchanged", async () => {
  const inner = new JSZip()
  inner.file("plugin.yml", "version: inner")
  const nested = await inner.generateAsync({ type: "nodebuffer" })
  const { file, original } = await fixture({
    ...metadata,
    "libs/inner.jar": nested,
    "META-INF/MANIFEST.MF": "Implementation-Version: 1.0\n",
  })
  const inspection = await inspectJar(file)
  expect(inspection.originalVersion).toBe("1.0")
  const result = await JSZip.loadAsync(await rewriteJar(inspection, file, "Display Name"))
  for (const name of Object.keys(metadata)) {
    assertRewrittenVersion(name as keyof typeof metadata, await result.file(name)!.async("string"), "Display Name")
  }
  expect(await result.file("libs/inner.jar")!.async("nodebuffer")).toEqual(nested)
  expect(await result.file("META-INF/MANIFEST.MF")!.async("string")).toBe("Implementation-Version: 1.0\n")
  expect(await readFile(file)).toEqual(original)
})

it.each([
  ["plugin.yml", "name: plugin"],
  ["paper-plugin.yml", "version: [oops"],
  ["fabric.mod.json", '{"version":2}'],
  ["quilt.mod.json", '{"quilt_loader":{}}'],
  ["META-INF/mods.toml", "modId = 'plugin'"],
  ["META-INF/neoforge.mods.toml", "[[mods]]\nversion = 2"],
])("rejects missing or malformed %s", async (name, content) => {
  const { file } = await fixture({ [name]: content })
  await expect(inspectJar(file)).rejects.toThrow(name)
})

it.each(["PLUGIN.SF", "plugin.rsa", "plugin.DSA", "plugin.Ec", "SIG-PLUGIN"])(
  "rejects META-INF/%s signature without touching raw bytes",
  async (marker) => {
    const { file, original } = await fixture({ "plugin.yml": "version: 1", [`META-INF/${marker}`]: "signature" })
    const inspection = await inspectJar(file)
    expect(() => assertUnsignedJar(inspection.zip, file)).toThrow(file)
    expect(await readFile(file)).toEqual(original)
  }
)

it("rejects a deliberately written slug instead of the display name", () => {
  expect(() => assertRewrittenVersion("plugin.yml", "version: slug\n", "Display Name")).toThrow("does not match")
  expect(() => assertRewrittenVersion("META-INF/mods.toml", '[[mods]]\nversion = "slug"\n', "Display Name")).toThrow(
    "does not match"
  )
})

it("writes a numeric YAML version back as a decoded string even when its value is unchanged", async () => {
  const { file } = await fixture({ "plugin.yml": "version: 1\n" })
  const jar = await JSZip.loadAsync(await rewriteJar(await inspectJar(file), file, "1"))
  const version = await jar.file("plugin.yml")!.async("string")
  assertRewrittenVersion("plugin.yml", version, "1")
  expect(version).toMatch(/version: ['"]1['"]/)
})

it("identifies the failing JAR when its ZIP is malformed", async () => {
  const { file } = await fixture({ "plugin.yml": "version: 1" })
  await writeFile(file, "not a JAR")
  await expect(inspectJar(file)).rejects.toThrow(`${file}: invalid JAR`)
})

it("rewrites an anchored YAML version without changing its dependency alias", async () => {
  const { file } = await fixture({ "plugin.yml": "version: &v old\ndependencies: {other: *v}\n" })
  const result = await JSZip.loadAsync(await rewriteJar(await inspectJar(file), file, "new"))
  expect(YAML.parse(await result.file("plugin.yml")!.async("string"))).toEqual({
    version: "new",
    dependencies: { other: "old" },
  })
})

it("preserves Unix executable and metadata/directory modes, dates, and comments", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "jar-unix-"))
  directories.push(directory)
  const file = path.join(directory, "plugin.jar")
  const date = new Date("2020-01-01T00:00:00Z")
  const zip = new JSZip()
  zip.file("bin/", "", { dir: true, unixPermissions: 0o40755, date, comment: "directory" })
  zip.file("bin/tool", "#!/bin/sh\n", { unixPermissions: 0o100755, date, comment: "executable", createFolders: false })
  zip.file("plugin.yml", "version: old\n", { unixPermissions: 0o100640, date, comment: "metadata" })
  const raw = await zip.generateAsync({ type: "nodebuffer", platform: "UNIX" })
  await writeFile(file, raw)
  const original = await JSZip.loadAsync(raw)
  const rewritten = await JSZip.loadAsync(await rewriteJar(await inspectJar(file), file, "new"))
  for (const name of ["bin/", "bin/tool", "plugin.yml"]) {
    expect(rewritten.files[name]?.unixPermissions).toBe(original.files[name]?.unixPermissions)
    expect(rewritten.files[name]?.unixPermissions).not.toBeNull()
    expect(rewritten.files[name]?.date).toEqual(original.files[name]?.date)
    expect(rewritten.files[name]?.comment).toBe(original.files[name]?.comment)
  }
  expect(rewritten.files["bin/tool"]?.unixPermissions).toBe(0o100755)
  expect(await rewritten.file("bin/tool")!.async("string")).toBe("#!/bin/sh\n")
})
