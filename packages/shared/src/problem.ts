import { z } from 'zod';

/** Stable error codes (docs/API.md section 12, plus three additive transport-level codes). */
export const ERROR_CODES = [
  'VALIDATION_FAILED',
  'CURSOR_INVALID',
  'UNAUTHENTICATED',
  'SESSION_EXPIRED',
  'NOT_FOUND',
  'METHOD_NOT_ALLOWED',
  'PAYLOAD_TOO_LARGE',
  'UNSUPPORTED_MEDIA_TYPE',
  'VERSION_CONFLICT',
  'INVALID_TRANSITION',
  'CLIENT_TOO_OLD',
  'PROCESSING_PAUSED',
  'RATE_LIMITED',
  'NOT_ON_BETA_LIST',
  'CONSENT_REQUIRED',
  'CONSENT_VARIANT_STALE',
  'INTEGRATION_NOT_CONNECTED',
  'INTEGRATION_NEEDS_REAUTH',
  'OAUTH_STATE_INVALID',
  'OAUTH_ACCOUNT_MISMATCH',
  'OAUTH_NO_REFRESH_TOKEN',
  'OAUTH_REDIRECT_NOT_ALLOWED',
  'OAUTH_CODE_INVALID',
  'IDEMPOTENCY_KEY_REUSED',
  'INTERNAL',
  'UPSTREAM_UNAVAILABLE',
] as const;

export type ErrorCode = (typeof ERROR_CODES)[number];

export const PROBLEM_CONTENT_TYPE = 'application/problem+json';

interface CatalogEntry {
  readonly status: number;
  readonly title: string;
}

export const PROBLEM_CATALOG: Readonly<Record<ErrorCode, CatalogEntry>> = {
  VALIDATION_FAILED: { status: 400, title: 'Request validation failed' },
  CURSOR_INVALID: { status: 400, title: 'Pagination cursor is invalid' },
  UNAUTHENTICATED: { status: 401, title: 'Authentication required' },
  SESSION_EXPIRED: { status: 401, title: 'Session expired' },
  NOT_FOUND: { status: 404, title: 'Resource not found' },
  METHOD_NOT_ALLOWED: { status: 405, title: 'Method not allowed' },
  PAYLOAD_TOO_LARGE: { status: 413, title: 'Request body too large' },
  UNSUPPORTED_MEDIA_TYPE: { status: 415, title: 'Unsupported media type' },
  VERSION_CONFLICT: { status: 409, title: 'Version conflict' },
  INVALID_TRANSITION: { status: 409, title: 'Invalid state transition' },
  CLIENT_TOO_OLD: { status: 426, title: 'Client upgrade required' },
  PROCESSING_PAUSED: { status: 423, title: 'Processing is paused' },
  RATE_LIMITED: { status: 429, title: 'Too many requests' },
  NOT_ON_BETA_LIST: { status: 403, title: 'Account is not on the beta list' },
  CONSENT_REQUIRED: { status: 403, title: 'Consent required' },
  CONSENT_VARIANT_STALE: { status: 409, title: 'Consent must be renewed' },
  INTEGRATION_NOT_CONNECTED: { status: 409, title: 'Integration is not connected' },
  INTEGRATION_NEEDS_REAUTH: { status: 409, title: 'Integration needs reconnection' },
  OAUTH_STATE_INVALID: { status: 400, title: 'OAuth state is invalid' },
  OAUTH_ACCOUNT_MISMATCH: { status: 400, title: 'OAuth account mismatch' },
  OAUTH_NO_REFRESH_TOKEN: { status: 400, title: 'No refresh token was issued' },
  OAUTH_REDIRECT_NOT_ALLOWED: { status: 400, title: 'OAuth redirect not allowed' },
  OAUTH_CODE_INVALID: { status: 400, title: 'OAuth code is invalid' },
  IDEMPOTENCY_KEY_REUSED: { status: 422, title: 'Idempotency key reused with a different request' },
  INTERNAL: { status: 500, title: 'Internal error' },
  UPSTREAM_UNAVAILABLE: { status: 502, title: 'Upstream service unavailable' },
};

/** `type` is a URN (valid URI reference) so no fictional documentation domain is implied. */
export function problemTypeFor(code: ErrorCode): string {
  return `urn:heed:problem:${code}`;
}

export const problemDetailsSchema = z.object({
  type: z.string().min(1),
  title: z.string().min(1),
  status: z.number().int().min(400).max(599),
  code: z.enum(ERROR_CODES),
  requestId: z.string().min(1),
  detail: z.string().optional(),
  errors: z.array(z.object({ path: z.string(), message: z.string() })).optional(),
});

export type ProblemDetails = z.infer<typeof problemDetailsSchema>;
