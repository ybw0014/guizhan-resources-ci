import { readFile } from "node:fs/promises"
import path from "node:path"

import JSZip from "jszip"
import { parse as parseToml } from "smol-toml"
import { parseDocument } from "yaml"

const descriptorPlatforms = [
  ["paper-plugin.yml", "paper"],
  ["plugin.yml", "spigot"],
  ["META-INF/mods.toml", "forge"],
  ["META-INF/neoforge.mods.toml", "neoforge"],
  ["fabric.mod.json", "fabric"],
  ["quilt.mod.json", "quilt"],
] as const

type Platform = (typeof descriptorPlatforms)[number][1]
type Matcher = (version: string) => boolean
type DescriptorResult = { platform: Platform; matcher?: Matcher }

export type CompatibilityScanResult = {
  hasRecognizedDescriptor: boolean
  platforms: string[]
  minecraftVersions?: string[]
}

function invalid(descriptor: string, message: string): never {
  throw new Error(`Invalid ${descriptor}: ${message}`)
}

function parseVersion(value: string, descriptor: string): number[] {
  if (!/^\d+(?:\.\d+)*$/.test(value)) invalid(descriptor, `unsupported Minecraft version "${value}"`)
  return value.split(".").map(Number)
}

function compareVersions(left: string, right: string, descriptor: string) {
  const leftParts = parseVersion(left, descriptor)
  const rightParts = parseVersion(right, descriptor)
  const length = Math.max(leftParts.length, rightParts.length)
  for (let index = 0; index < length; index += 1) {
    const difference = (leftParts[index] ?? 0) - (rightParts[index] ?? 0)
    if (difference !== 0) return Math.sign(difference)
  }
  return 0
}

function matchesAll(matchers: Matcher[]): Matcher {
  return (version) => matchers.every((matcher) => matcher(version))
}

function matchesAny(matchers: Matcher[]): Matcher {
  return (version) => matchers.some((matcher) => matcher(version))
}

function parsePluginMatcher(value: unknown, descriptor: string): Matcher | undefined {
  if (value === undefined) return undefined
  if (typeof value !== "string") invalid(descriptor, "api-version must be a string scalar")
  const parts = value.split(".")
  if ((parts.length !== 2 && parts.length !== 3) || parts.some((part) => !/^\d+$/.test(part))) {
    invalid(descriptor, `unsupported api-version "${value}"`)
  }

  const family = parts.slice(0, 2).join(".")
  return (version) => {
    const versionParts = parseVersion(version, descriptor)
    if (versionParts.length < 2 || versionParts.slice(0, 2).join(".") !== family) return false
    return parts.length === 2 || compareVersions(version, value, descriptor) >= 0
  }
}

function parseMavenMatcher(value: unknown, descriptor: string): Matcher {
  if (typeof value !== "string" || value.trim() === "") invalid(descriptor, "versionRange must be a non-empty string")
  const range = value.trim()
  if (range.includes("${")) invalid(descriptor, "unexpanded version property")

  if (!/[[(]/.test(range)) {
    parseVersion(range, descriptor)
    // Maven bare versions are soft requirements. We deliberately simplify them
    // to >= rather than strictly reproducing Maven, including cross-family matches.
    return (version) => compareVersions(version, range, descriptor) >= 0
  }

  const ranges: Matcher[] = []
  let offset = 0
  while (offset < range.length) {
    const opener = range[offset]
    if (opener !== "[" && opener !== "(") invalid(descriptor, `invalid Maven range "${range}"`)
    const closerIndex = [...range.slice(offset + 1)].findIndex((character) => character === "]" || character === ")")
    if (closerIndex === -1) invalid(descriptor, `invalid Maven range "${range}"`)
    const closingIndex = offset + closerIndex + 1
    const body = range.slice(offset + 1, closingIndex)
    const parts = body.split(",")
    if (parts.length > 2 || parts.some((part) => part.includes("[") || part.includes("("))) {
      invalid(descriptor, `invalid Maven range "${range}"`)
    }

    if (parts.length === 1) {
      if (opener !== "[" || range[closingIndex] !== "]") invalid(descriptor, `invalid Maven range "${range}"`)
      const exact = parts[0]!.trim()
      parseVersion(exact, descriptor)
      ranges.push((version) => compareVersions(version, exact, descriptor) === 0)
    } else {
      const lower = parts[0]!.trim()
      const upper = parts[1]!.trim()
      if (!lower && !upper) invalid(descriptor, `invalid Maven range "${range}"`)
      if (lower) parseVersion(lower, descriptor)
      if (upper) parseVersion(upper, descriptor)
      const closing = range[closingIndex]!
      ranges.push((version) => {
        const lowerMatches =
          !lower ||
          compareVersions(version, lower, descriptor) > 0 ||
          (opener === "[" && compareVersions(version, lower, descriptor) === 0)
        const upperMatches =
          !upper ||
          compareVersions(version, upper, descriptor) < 0 ||
          (closing === "]" && compareVersions(version, upper, descriptor) === 0)
        return lowerMatches && upperMatches
      })
    }

    offset = closingIndex + 1
    if (offset === range.length) break
    if (range[offset] !== ",") invalid(descriptor, `invalid Maven range "${range}"`)
    offset += 1
  }
  return matchesAny(ranges)
}

function nextVersion(version: string, index: number, descriptor: string) {
  const parts = parseVersion(version, descriptor)
  const next = parts.slice(0, index + 1)
  next[index] = (next[index] ?? 0) + 1
  return next.join(".")
}

function parseSimpleMatcher(value: string, descriptor: string, bareMode: "exact" | "caret"): Matcher {
  if (value === "*") return () => true
  const wildcard = /^(\d+(?:\.\d+)*)\.(?:x|\*)$/.exec(value)
  if (wildcard) {
    const prefix = wildcard[1]!
    parseVersion(prefix, descriptor)
    return (version) => version === prefix || version.startsWith(`${prefix}.`)
  }

  const comparator = /^(>=|<=|>|<|=)(\d+(?:\.\d+)*)$/.exec(value)
  if (comparator) {
    const [, operator, compared] = comparator
    parseVersion(compared!, descriptor)
    return (version) => {
      const comparison = compareVersions(version, compared!, descriptor)
      return operator === ">="
        ? comparison >= 0
        : operator === "<="
          ? comparison <= 0
          : operator === ">"
            ? comparison > 0
            : operator === "<"
              ? comparison < 0
              : comparison === 0
    }
  }

  const shorthand = /^(~|\^)(\d+(?:\.\d+)*)$/.exec(value)
  if (shorthand) {
    const [, operator, base] = shorthand
    parseVersion(base!, descriptor)
    const upper =
      operator === "~"
        ? nextVersion(base!, Math.min(1, base!.split(".").length - 1), descriptor)
        : nextVersion(base!, 0, descriptor)
    return (version) =>
      compareVersions(version, base!, descriptor) >= 0 && compareVersions(version, upper, descriptor) < 0
  }

  parseVersion(value, descriptor)
  if (bareMode === "exact") return (version) => compareVersions(version, value, descriptor) === 0
  const upper = nextVersion(value, 0, descriptor)
  return (version) =>
    compareVersions(version, value, descriptor) >= 0 && compareVersions(version, upper, descriptor) < 0
}

function parseFabricMatcher(value: unknown, descriptor: string): Matcher {
  if (Array.isArray(value)) return matchesAny(value.map((item) => parseFabricMatcher(item, descriptor)))
  if (typeof value !== "string" || value.trim() === "")
    invalid(descriptor, "depends.minecraft must be a non-empty string or array")
  return matchesAll(
    value
      .trim()
      .split(/\s+/)
      .map((part) => parseSimpleMatcher(part, descriptor, "exact"))
  )
}

function parseQuiltMatcher(value: unknown, descriptor: string): Matcher {
  if (Array.isArray(value)) return matchesAny(value.map((item) => parseQuiltMatcher(item, descriptor)))
  if (typeof value === "string") {
    if (value.startsWith("=")) return parseSimpleMatcher(value, descriptor, "exact")
    return parseSimpleMatcher(value, descriptor, "caret")
  }
  if (!value || typeof value !== "object") invalid(descriptor, "versions must be a string, array, any, or all")
  const record = value as Record<string, unknown>
  if (Object.keys(record).some((key) => key !== "any" && key !== "all"))
    invalid(descriptor, "versions contains unknown keys")
  if ("any" in record && "all" in record) invalid(descriptor, "versions cannot contain both any and all")
  if ("any" in record) {
    if (!Array.isArray(record.any) || record.any.length === 0)
      invalid(descriptor, "versions.any must be a non-empty array")
    return matchesAny(record.any.map((item) => parseQuiltMatcher(item, descriptor)))
  }
  if ("all" in record) {
    if (!Array.isArray(record.all) || record.all.length === 0)
      invalid(descriptor, "versions.all must be a non-empty array")
    return matchesAll(record.all.map((item) => parseQuiltMatcher(item, descriptor)))
  }
  invalid(descriptor, "versions must contain any or all")
}

function parseYamlDescriptor(content: string, descriptor: string): Matcher | undefined {
  const document = parseDocument(content, { schema: "failsafe" })
  if (document.errors.length > 0) invalid(descriptor, document.errors.map((error) => error.message).join("; "))
  const root = document.toJS()
  if (!root || typeof root !== "object" || Array.isArray(root)) return undefined
  return parsePluginMatcher((root as Record<string, unknown>)["api-version"], descriptor)
}

function parseTomlDependencies(content: string, descriptor: string, isNeoForge: boolean): Matcher | undefined {
  let parsed: unknown
  try {
    parsed = parseToml(content)
  } catch (error) {
    invalid(descriptor, error instanceof Error ? error.message : "malformed TOML")
  }
  const dependencies = (parsed as Record<string, unknown>).dependencies
  if (!dependencies || typeof dependencies !== "object" || Array.isArray(dependencies)) return undefined
  const matchers: Matcher[] = []
  for (const values of Object.values(dependencies as Record<string, unknown>)) {
    if (!Array.isArray(values)) continue
    for (const dependency of values) {
      if (!dependency || typeof dependency !== "object") invalid(descriptor, "dependency must be a table")
      const record = dependency as Record<string, unknown>
      if (record.modId !== "minecraft") continue
      if (isNeoForge && record.type !== undefined) {
        if (typeof record.type !== "string") invalid(descriptor, "minecraft dependency type must be a string")
        const dependencyType = record.type.toLowerCase()
        if (dependencyType === "incompatible" || dependencyType === "discouraged") {
          invalid(descriptor, `unsupported minecraft dependency type "${record.type}"`)
        }
        if (dependencyType !== "required" && dependencyType !== "optional") {
          invalid(descriptor, `unsupported minecraft dependency type "${record.type}"`)
        }
      }
      matchers.push(parseMavenMatcher(record.versionRange, descriptor))
    }
  }
  return matchers.length === 0 ? undefined : matchesAll(matchers)
}

function parseJson(content: string, descriptor: string): Record<string, unknown> {
  try {
    return JSON.parse(content.replace(/^\uFEFF/, "")) as Record<string, unknown>
  } catch (error) {
    invalid(descriptor, error instanceof Error ? error.message : "malformed JSON")
  }
}

function parseFabricDescriptor(content: string, descriptor: string): Matcher | undefined {
  const depends = parseJson(content, descriptor).depends
  if (!depends || typeof depends !== "object" || Array.isArray(depends)) return undefined
  const minecraft = (depends as Record<string, unknown>).minecraft
  return minecraft === undefined ? undefined : parseFabricMatcher(minecraft, descriptor)
}

function parseQuiltDescriptor(content: string, descriptor: string): Matcher | undefined {
  const depends = parseJson(content, descriptor).quilt_loader
  if (!depends || typeof depends !== "object" || Array.isArray(depends)) return undefined
  const dependencies = (depends as Record<string, unknown>).depends
  if (dependencies === undefined) return undefined
  if (!Array.isArray(dependencies)) invalid(descriptor, "quilt_loader.depends must be an array")
  const matchers: Matcher[] = []
  for (const dependency of dependencies) {
    if (!dependency || typeof dependency !== "object" || Array.isArray(dependency))
      invalid(descriptor, "dependency must be an object")
    const record = dependency as Record<string, unknown>
    if (record.id !== "minecraft") continue
    // Missing versions defaults to "*" per Quilt spec; explicit null is invalid
    const versions = record.versions === undefined ? "*" : record.versions
    matchers.push(parseQuiltMatcher(versions, descriptor))
  }
  return matchers.length === 0 ? undefined : matchesAll(matchers)
}

async function scanJar(jarPath: string): Promise<DescriptorResult[]> {
  let zip: JSZip
  try {
    zip = await JSZip.loadAsync(await readFile(jarPath))
  } catch {
    return []
  }
  const names = new Set(Object.keys(zip.files))
  const results: DescriptorResult[] = []
  const hasPaperDescriptor = names.has("paper-plugin.yml")
  for (const [filename, platform] of descriptorPlatforms) {
    if (!names.has(filename)) continue
    if (filename === "plugin.yml" && hasPaperDescriptor && results[0]?.matcher) continue
    const content = await zip.file(filename)!.async("string")
    let matcher: Matcher | undefined
    if (filename === "paper-plugin.yml" || filename === "plugin.yml") matcher = parseYamlDescriptor(content, filename)
    else if (filename === "META-INF/mods.toml") matcher = parseTomlDependencies(content, filename, false)
    else if (filename === "META-INF/neoforge.mods.toml") matcher = parseTomlDependencies(content, filename, true)
    else if (filename === "fabric.mod.json") matcher = parseFabricDescriptor(content, filename)
    else matcher = parseQuiltDescriptor(content, filename)
    if (filename === "plugin.yml" && hasPaperDescriptor) {
      if (!results[0]?.matcher && matcher) results[0] = { platform: "paper", matcher }
      continue
    }
    results.push({ platform, matcher })
  }
  return results
}

export async function scanMinecraftCompatibility(
  artifactPaths: string[],
  catalog: string[]
): Promise<CompatibilityScanResult> {
  const descriptorResults = (
    await Promise.all(
      artifactPaths
        .filter(
          (artifactPath) =>
            /\.jar$/i.test(artifactPath) && !/(?:-sources|-javadoc)\.jar$/i.test(path.basename(artifactPath))
        )
        .map(scanJar)
    )
  ).flat()
  const platforms = descriptorPlatforms
    .map(([, platform]) => platform)
    .filter((platform, index, all) => all.indexOf(platform) === index)
  const detectedPlatforms = platforms.filter((platform) =>
    descriptorResults.some((result) => result.platform === platform)
  )
  const matchers = descriptorResults.flatMap((result) => (result.matcher ? [result.matcher] : []))
  const minecraftVersions =
    matchers.length === 0 ? undefined : catalog.filter((version) => matchers.some((matcher) => matcher(version)))
  if (minecraftVersions && minecraftVersions.length === 0)
    throw new Error("Minecraft compatibility constraints matched no canonical versions")
  return {
    hasRecognizedDescriptor: descriptorResults.length > 0,
    platforms: detectedPlatforms,
    ...(minecraftVersions ? { minecraftVersions } : {}),
  }
}
