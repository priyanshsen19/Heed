import type { Logger } from 'pino';
import type { ServerConfig } from '@heed/config';
import type { Clock } from '@heed/shared';
import type { OidcVerifier } from './ports/oidc';
import type { RateLimiter } from './ports/rate-limiter';
import type { ReadinessCheck } from './ports/readiness';
import type { TickHandler } from './ports/tick';

/** Everything the application needs, injected. createApp reads no environment and owns no globals. */
export interface AppDependencies {
  readonly config: ServerConfig;
  readonly clock: Clock;
  readonly logger: Logger;
  readonly rateLimiter: RateLimiter;
  readonly readinessChecks: readonly ReadinessCheck[];
  /** Required to expose /internal/tick; absent means the endpoint does not exist. */
  readonly oidcVerifier?: OidcVerifier;
  readonly tickHandlers?: readonly TickHandler[];
  /** Instance lifecycle flag (draining on SIGTERM). Not business state. */
  readonly isDraining?: () => boolean;
}
