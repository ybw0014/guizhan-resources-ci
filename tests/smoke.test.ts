import { describe, expect, it } from "vitest"

import { hello } from "../src/index.js"

describe("hello", () => {
  it("returns hello", () => {
    expect(hello()).toBe("hello")
  })
})
