import type { Clock } from '@heed/shared';

/**
 * Tick handlers are the units of scheduled work run by `POST /internal/tick` (docs/ARCHITECTURE.md
 * 4.4). Stage 1 defines only the contract and an empty registry; sync, reminder, and purge handlers
 * arrive in later stages. Every handler must be idempotent and bounded by the time budget.
 */
export interface TickContext {
  readonly clock: Clock;
  /** Wall-clock budget for the whole tick, in milliseconds. */
  readonly budgetMs: number;
}

export interface TickHandler {
  readonly name: string;
  run(context: TickContext): Promise<void>;
}
