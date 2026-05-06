import { mkdir, readFile, writeFile } from "node:fs/promises"
import path from "node:path"

const projectRoot = process.cwd()
const sourcePath = path.join(projectRoot, "src", "main", "java", "io", "github", "guizhan", "resources", "fixture", "ExamplePlugin.java")
const pomPath = path.join(projectRoot, "pom.xml")
const targetDirectory = path.join(projectRoot, "target")
const artifactPath = path.join(targetDirectory, "java-maven-fixture.jar")
const source = await readFile(sourcePath, "utf8")
const pom = await readFile(pomPath, "utf8")

await mkdir(targetDirectory, { recursive: true })
await writeFile(artifactPath, `fixture jar\nsource:${source.length}\npom:${pom.length}\n`)
