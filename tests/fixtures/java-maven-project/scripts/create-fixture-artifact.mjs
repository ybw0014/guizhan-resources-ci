import { mkdir, writeFile } from "node:fs/promises"
import path from "node:path"

const projectRoot = process.cwd()
const targetDirectory = path.join(projectRoot, "target")
const artifactPath = path.join(targetDirectory, "java-maven-fixture.jar")

await mkdir(targetDirectory, { recursive: true })
const fixtureJar =
  "UEsDBAoAAAAAANckHV3xy6qeIwAAACMAAAAKAAAAcGx1Z2luLnltbG5hbWU6IEV4YW1wbGVQbHVnaW4KdmVyc2lvbjogMS4wLjAKUEsDBAoAAAAAANckHV2sLGB1CAAAAAgAAAALAAAAZml4dHVyZS50eHRmaXh0dXJlClBLAQIUAAoAAAAAANckHV3xy6qeIwAAACMAAAAKAAAAAAAAAAAAAAAAAAAAAABwbHVnaW4ueW1sUEsBAhQACgAAAAAA1yQdXawsYHUIAAAACAAAAAsAAAAAAAAAAAAAAAAASwAAAGZpeHR1cmUudHh0UEsFBgAAAAACAAIAcQAAAHwAAAAAAA=="
await writeFile(artifactPath, Buffer.from(fixtureJar, "base64"))
