export function generateRunName(idempotencyKey: string, runId: string): string {
  return `guizhan-resources-${idempotencyKey}-${runId}`
}

export function generateArtifactName(idempotencyKey: string, name: string): string {
  return `${idempotencyKey}-${name}`
}
