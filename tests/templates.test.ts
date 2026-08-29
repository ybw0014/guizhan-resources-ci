import { describe, expect, it } from "vitest"

import { buildPayloadSchema } from "../src/schema.js"
import { createTemplateValues, renderTemplate } from "../src/templates.js"
import branchPayload from "./fixtures/branch-payload.json" with { type: "json" }

describe("automation templates", () => {
  it("renders all variables once and uses empty strings for missing optional values", () => {
    const payload = buildPayloadSchema.parse({
      ...branchPayload,
      source_resolved_identifier: "v1.2.0",
      source_commit_message: "{repo}",
      channel_version_count: 3,
    })
    const values = createTemplateValues(payload, "1.0.0")

    expect(
      renderTemplate(
        "{identifier}|{mode}|{commit_sha}|{repo}|{profile}|{channel_seq}|{jar_version}|{commit_message}",
        values
      )
    ).toBe("v1.2.0|branch|abcdef1|ybw0014/example-plugin|default|4|1.0.0|{repo}")
    expect(renderTemplate("{channel_seq}:{jar_version}:{commit_message}", createTemplateValues(buildPayloadSchema.parse(branchPayload)))).toBe(
      "::"
    )
  })

  it("rejects complete unknown variables while retaining unclosed tokens literally", () => {
    const values = createTemplateValues(buildPayloadSchema.parse(branchPayload))

    expect(() => renderTemplate("{unknown}", values)).toThrow("Unknown template variable: {unknown}")
    expect(() => renderTemplate("{foo-bar}", values)).toThrow("Unknown template variable: {foo-bar}")
    expect(() => renderTemplate("{123}", values)).toThrow("Unknown template variable: {123}")
    expect(renderTemplate("before {identifier after", values)).toBe("before {identifier after")
  })
})
