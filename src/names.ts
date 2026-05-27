export function generateRunName(idempotencyKey: string, runId: string): string {
  return `Auto Build ${runId} ${idempotencyKey}`
}

export function generateArtifactName(idempotencyKey: string, name: string): string {
  const safeKey = idempotencyKey.replace(/[\\/:*?"<>|]/g, "-")

  return `${safeKey}-${name}`
}
