import type { FastifyInstance } from 'fastify';
import { createApp } from './app';
import type { AppDependencies } from './deps';

export interface RunningServer {
  readonly app: FastifyInstance;
  /** Marks the instance not-ready so the load balancer stops sending traffic, then stops accepting. */
  drain(): void;
  close(): Promise<void>;
}

/**
 * Opens the network port. Kept separate from createApp so everything else is testable without a
 * socket. `draining` is an instance lifecycle flag (graceful shutdown), not business state.
 */
export async function startServer(
  deps: Omit<AppDependencies, 'isDraining'>,
): Promise<RunningServer> {
  let draining = false;
  const app = await createApp({ ...deps, isDraining: () => draining });
  await app.listen({ host: deps.config.host, port: deps.config.port });
  return {
    app,
    drain() {
      draining = true;
    },
    close() {
      return app.close();
    },
  };
}
