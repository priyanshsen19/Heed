/** Header used to carry the correlation id. It is a correlation aid only, never an authenticator. */
export const REQUEST_ID_HEADER = 'x-request-id';

const SAFE_REQUEST_ID = /^[A-Za-z0-9._-]{8,64}$/;

/** A caller-supplied request id is propagated only if it is short and made of safe characters. */
export function isSafeRequestId(value: unknown): value is string {
  return typeof value === 'string' && SAFE_REQUEST_ID.test(value);
}
