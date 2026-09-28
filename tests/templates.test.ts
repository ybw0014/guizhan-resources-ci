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
    expect(
      renderTemplate(
        "{channel_seq}:{jar_version}:{commit_message}",
        createTemplateValues(buildPayloadSchema.parse(branchPayload))
      )
    ).toBe("::")
  })

  it("rejects complete unknown variables while retaining unclosed tokens literally", () => {
    const values = createTemplateValues(buildPayloadSchema.parse(branchPayload))

    expect(() => renderTemplate("{unknown}", values)).toThrow("Unknown template variable: {unknown}")
    expect(() => renderTemplate("{foo-bar}", values)).toThrow("Unknown template variable: {foo-bar}")
    expect(() => renderTemplate("{123}", values)).toThrow("Unknown template variable: {123}")
    expect(renderTemplate("before {identifier after", values)).toBe("before {identifier after")
    for (const token of ["{version}", "{basename}", "{ext}"]) {
      expect(() => renderTemplate(token, values)).toThrow("Unknown template variable")
    }
  })

  it("uses the same single-pass renderer for filename-only variables", () => {
    const values = createTemplateValues(
      buildPayloadSchema.parse({ ...branchPayload, channel_version_count: 7 }),
      "{channel_seq}"
    )
    expect(
      renderTemplate("{jar_version}-{channel_seq}-{version}-{basename}", {
        ...values,
        version: "slug",
        basename: "Original-sources",
      })
    ).toBe("{channel_seq}-8-slug-Original-sources")
    expect(() =>
      renderTemplate("{version}{ext}", { ...values, version: "slug", basename: "Original-sources" })
    ).toThrow("Unknown template variable: {ext}")
  })
})
