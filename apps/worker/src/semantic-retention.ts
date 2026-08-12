import type { SemanticGenerationRepository } from "./semantic-generation-contracts";

export function createSemanticRetentionSweepHandler(
  repository: SemanticGenerationRepository,
  clock: { now(): Date } = { now: () => new Date() },
) {
  return async (): Promise<{ scanned: number; requeued: number }> =>
    repository.sweepDueSemanticPrivate(clock.now(), 100);
}
