import type { FastifyInstance } from 'fastify';

/**
 * Mount point for the versioned product API (`/v1/...`, docs/API.md). Stage 1 deliberately registers
 * no product routes: no unversioned product endpoints may exist, and no fake integration responses.
 */
export function v1Routes(_app: FastifyInstance): void {
  // Product routes arrive in later stages.
}
