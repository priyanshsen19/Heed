import type { z } from 'zod';
import { problemDetailsSchema, type ErrorCode, type ProblemDetails } from '@heed/shared';

export type ApiErrorCode = ErrorCode | 'NETWORK' | 'TIMEOUT' | 'UNEXPECTED_RESPONSE';

/** Never carries response bodies, tokens, or headers in its message. */
export class ApiError extends Error {
  override readonly name = 'ApiError';

  constructor(
    readonly status: number,
    readonly code: ApiErrorCode,
    readonly requestId?: string,
    readonly problem?: ProblemDetails,
  ) {
    super(code);
  }
}

export interface ApiRequest<T> {
  readonly method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';
  /** Versioned product path, e.g. `/v1/tasks`. Anything else is refused. */
  readonly path: string;
  readonly body?: unknown;
  readonly schema: z.ZodType<T>;
  readonly idempotencyKey?: string;
  readonly ifMatch?: string;
}

export interface ApiClient {
  request<T>(request: ApiRequest<T>): Promise<T>;
}

export interface ApiClientOptions {
  readonly apiOrigin: string;
  readonly clientVersion: string;
  /** The Heed-scoped opaque session token, if signed in. */
  readonly getSessionToken: () => Promise<string | undefined>;
  /** Called when the server rejects the session; the caller clears local state. */
  readonly onSessionRejected?: () => Promise<void>;
  readonly fetchFn?: typeof fetch;
  readonly timeoutMs?: number;
  readonly newRequestId?: () => string;
}

const DEFAULT_TIMEOUT_MS = 15_000;

/**
 * The extension's only network peer is the Heed API (docs/ARCHITECTURE.md section 1). The client talks
 * to `${apiOrigin}/v1/...` only, over explicit Bearer authentication: no cookies (credentials omitted),
 * no redirects, no caching, no referrers.
 */
export function createApiClient(options: ApiClientOptions): ApiClient {
  const fetchFn = options.fetchFn ?? fetch;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const newRequestId = options.newRequestId ?? (() => crypto.randomUUID());

  return {
    async request<T>(request: ApiRequest<T>): Promise<T> {
      if (
        !request.path.startsWith('/v1/') ||
        request.path.includes('//') ||
        request.path.includes('..')
      ) {
        throw new ApiError(0, 'VALIDATION_FAILED');
      }
      const url = new URL(request.path, options.apiOrigin);
      if (url.origin !== options.apiOrigin) {
        throw new ApiError(0, 'VALIDATION_FAILED');
      }

      const requestId = newRequestId();
      const headers: Record<string, string> = {
        accept: 'application/json',
        'x-request-id': requestId,
        'x-heed-client': `extension/${options.clientVersion}`,
      };
      const token = await options.getSessionToken();
      if (token !== undefined) {
        headers['authorization'] = `Bearer ${token}`;
      }
      if (request.body !== undefined) {
        headers['content-type'] = 'application/json';
      }
      if (request.idempotencyKey !== undefined) {
        headers['idempotency-key'] = request.idempotencyKey;
      }
      if (request.ifMatch !== undefined) {
        headers['if-match'] = request.ifMatch;
      }

      let response: Response;
      try {
        response = await fetchFn(url, {
          method: request.method,
          headers,
          ...(request.body !== undefined ? { body: JSON.stringify(request.body) } : {}),
          credentials: 'omit',
          cache: 'no-store',
          redirect: 'error',
          referrerPolicy: 'no-referrer',
          signal: AbortSignal.timeout(timeoutMs),
        });
      } catch (error) {
        const timedOut =
          error instanceof DOMException &&
          (error.name === 'TimeoutError' || error.name === 'AbortError');
        throw new ApiError(0, timedOut ? 'TIMEOUT' : 'NETWORK', requestId);
      }

      const responseRequestId = response.headers.get('x-request-id') ?? requestId;

      if (!response.ok) {
        let problem: ProblemDetails | undefined;
        if (response.headers.get('content-type')?.includes('application/problem+json') === true) {
          const parsed = problemDetailsSchema.safeParse(
            await response.json().catch(() => undefined),
          );
          problem = parsed.success ? parsed.data : undefined;
        }
        if (
          problem !== undefined &&
          (problem.code === 'UNAUTHENTICATED' || problem.code === 'SESSION_EXPIRED')
        ) {
          await options.onSessionRejected?.();
        }
        throw new ApiError(
          response.status,
          problem?.code ?? 'UNEXPECTED_RESPONSE',
          responseRequestId,
          problem,
        );
      }

      const payload: unknown =
        response.status === 204 ? undefined : await response.json().catch(() => undefined);
      const parsed = request.schema.safeParse(payload);
      if (!parsed.success) {
        throw new ApiError(response.status, 'UNEXPECTED_RESPONSE', responseRequestId);
      }
      return parsed.data;
    },
  };
}
