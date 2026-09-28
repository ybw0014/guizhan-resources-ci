import { lstat, realpath } from "node:fs/promises"
import path from "node:path"

import {
  BUILD_DIRECTORY_SEGMENT_MAX_LENGTH,
  BUILD_DIRECTORY_SEGMENT_REGEX,
  FORBIDDEN_BUILD_DIRECTORY_SEGMENTS,
} from "./config.js"

export function isValidBuildDirectory(directory: string): boolean {
  if (directory === ".") return true
  return directory
    .split("/")
    .every(
      (segment) =>
        segment.length > 0 &&
        segment.length <= BUILD_DIRECTORY_SEGMENT_MAX_LENGTH &&
        BUILD_DIRECTORY_SEGMENT_REGEX.test(segment) &&
        !FORBIDDEN_BUILD_DIRECTORY_SEGMENTS.has(segment.toLowerCase())
    )
}

export async function resolveBuildDirectory(checkoutRoot: string, directory: string): Promise<string> {
  if (!isValidBuildDirectory(directory)) throw new Error(`Invalid build directory: ${directory}`)

  const root = path.resolve(checkoutRoot)
  if ((await lstat(root)).isSymbolicLink()) throw new Error("Checkout root must not be a symlink")
  const realRoot = await realpath(root)
  if (!(await lstat(realRoot)).isDirectory()) throw new Error("Checkout root is not a directory")

  let resolved = realRoot
  for (const segment of directory === "." ? [] : directory.split("/")) {
    resolved = path.join(resolved, segment)
    const info = await lstat(resolved)
    if (info.isSymbolicLink() || !info.isDirectory()) {
      throw new Error(`Build directory contains a symlink or non-directory: ${resolved}`)
    }
    const actual = await realpath(resolved)
    if (!actual.startsWith(`${realRoot}${path.sep}`)) throw new Error("Build directory escapes checkout root")
  }

  return resolved
}
