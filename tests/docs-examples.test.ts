import { describe, it, expect } from 'vitest'
import * as fs from 'fs'
import * as path from 'path'
import { buildPayloadSchema, callbackPayloadSchema, runnerManifestSchema } from '../src/schema.js'

describe('Documentation Examples', () => {
  const examplesDir = path.join(__dirname, '../examples')

  it('build-payload.json should be valid', () => {
    const data = JSON.parse(fs.readFileSync(path.join(examplesDir, 'build-payload.json'), 'utf-8'))
    expect(() => buildPayloadSchema.parse(data)).not.toThrow()
  })

  it('callback-payload.json should be valid', () => {
    const data = JSON.parse(fs.readFileSync(path.join(examplesDir, 'callback-payload.json'), 'utf-8'))
    expect(() => callbackPayloadSchema.parse(data)).not.toThrow()
  })

  it('runner-manifest.json should be valid', () => {
    const data = JSON.parse(fs.readFileSync(path.join(examplesDir, 'runner-manifest.json'), 'utf-8'))
    expect(() => runnerManifestSchema.parse(data)).not.toThrow()
  })
})
