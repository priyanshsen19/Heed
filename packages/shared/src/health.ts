import { z } from 'zod';

/** `/healthz`: the process is alive. No dependencies are consulted. */
export const healthzResponseSchema = z.object({ status: z.literal('ok') });
export type HealthzResponse = z.infer<typeof healthzResponseSchema>;

/** `/readyz`: constant, detail-free response (docs/API.md section 10). Details go to logs only. */
export const readyzResponseSchema = z.object({ status: z.enum(['ready', 'not_ready']) });
export type ReadyzResponse = z.infer<typeof readyzResponseSchema>;
