import { createHmac, timingSafeEqual } from "node:crypto"

export type BuildPayloadSignatureInput = {
  secret?: string
  timestamp?: string
  signature?: string
}

export function signBuildPayload(rawPayload: string, secret: string, timestamp: string): string {
  const digest = createHmac("sha256", secret).update(`${timestamp}.${rawPayload}`).digest("hex")

  return `sha256=${digest}`
}

export function verifyBuildPayloadSignature(rawPayload: string, input: BuildPayloadSignatureInput): void {
  if (!input.secret) {
    throw new Error("AUTO_BUILD_CALLBACK_SECRET is required for build payload verification")
  }

  if (!input.timestamp || !/^\d+$/.test(input.timestamp)) {
    throw new Error("BUILD_PAYLOAD_TIMESTAMP is required for build payload verification")
  }

  if (!input.signature) {
    throw new Error("BUILD_PAYLOAD_SIGNATURE is required for build payload verification")
  }

  const expected = signBuildPayload(rawPayload, input.secret, input.timestamp)
  const expectedBuffer = Buffer.from(expected, "utf8")
  const actualBuffer = Buffer.from(input.signature, "utf8")

  if (expectedBuffer.byteLength !== actualBuffer.byteLength || !timingSafeEqual(expectedBuffer, actualBuffer)) {
    throw new Error("Invalid build payload signature")
  }
}
