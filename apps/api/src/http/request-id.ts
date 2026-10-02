import type { IncomingMessage } from 'node:http';
import { randomUUID } from 'node:crypto';
import { REQUEST_ID_HEADER, isSafeRequestId } from '@heed/shared';

/**
 * Generates or propagates the request id. A caller-supplied `X-Request-ID` is propagated only if it is
 * short and made of safe characters; anything else is replaced. The id is a correlation aid for logs and
 * error bodies, never an authenticator.
 */
export function genReqId(req: IncomingMessage): string {
  const supplied = req.headers[REQUEST_ID_HEADER];
  const candidate = Array.isArray(supplied) ? supplied[0] : supplied;
  return isSafeRequestId(candidate) ? candidate : randomUUID();
}
