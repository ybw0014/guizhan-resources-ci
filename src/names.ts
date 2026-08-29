export function generateRunName(runId: string): string {
  return `Auto Build ${runId}`
}

export function generateArtifactName(idempotencyKey: string, name: string): string {
  const safeKey = idempotencyKey.replace(/[\\/:*?"<>|]/g, "-")

  return `${safeKey}-${name}`
}
