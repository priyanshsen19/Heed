/**
 * Readiness answers "can this instance serve traffic?" by consulting required runtime dependencies.
 * Stage 1 registers configuration and secrets; Stage 2 adds the database. `/healthz` never uses this:
 * liveness must not depend on any dependency.
 */
export interface ReadinessCheck {
  readonly name: string;
  check(): Promise<boolean>;
}

export interface ReadinessResult {
  readonly ready: boolean;
  readonly failed: readonly string[];
}

const CHECK_TIMEOUT_MS = 2000;

async function runWithTimeout(check: ReadinessCheck): Promise<boolean> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<boolean>((resolve) => {
    timer = setTimeout(() => {
      resolve(false);
    }, CHECK_TIMEOUT_MS);
  });
  try {
    return await Promise.race([check.check().catch(() => false), timeout]);
  } finally {
    if (timer !== undefined) {
      clearTimeout(timer);
    }
  }
}

export async function evaluateReadiness(
  checks: readonly ReadinessCheck[],
): Promise<ReadinessResult> {
  const outcomes = await Promise.all(
    checks.map(async (check) => ({ name: check.name, ok: await runWithTimeout(check) })),
  );
  const failed = outcomes.filter((outcome) => !outcome.ok).map((outcome) => outcome.name);
  return { ready: failed.length === 0, failed };
}
