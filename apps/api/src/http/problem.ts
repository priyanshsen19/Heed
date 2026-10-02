import type { FastifyError, FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import {
  hasZodFastifySchemaValidationErrors,
  isResponseSerializationError,
} from 'fastify-type-provider-zod';
import {
  PROBLEM_CATALOG,
  PROBLEM_CONTENT_TYPE,
  problemTypeFor,
  type ErrorCode,
  type ProblemDetails,
} from '@heed/shared';

/** Throw this from handlers to produce a specific, documented problem response. */
export class HttpProblem extends Error {
  override readonly name = 'HttpProblem';

  constructor(
    readonly code: ErrorCode,
    readonly detail?: string,
    readonly options: {
      readonly errors?: readonly { path: string; message: string }[];
      readonly headers?: Readonly<Record<string, string>>;
    } = {},
  ) {
    super(code);
  }
}

export function buildProblem(
  code: ErrorCode,
  requestId: string,
  extra: { detail?: string; errors?: readonly { path: string; message: string }[] } = {},
): ProblemDetails {
  const entry = PROBLEM_CATALOG[code];
  return {
    type: problemTypeFor(code),
    title: entry.title,
    status: entry.status,
    code,
    requestId,
    ...(extra.detail !== undefined ? { detail: extra.detail } : {}),
    ...(extra.errors !== undefined && extra.errors.length > 0 ? { errors: [...extra.errors] } : {}),
  };
}

export function sendProblem(
  reply: FastifyReply,
  code: ErrorCode,
  extra: {
    detail?: string;
    errors?: readonly { path: string; message: string }[];
    headers?: Readonly<Record<string, string>>;
  } = {},
): FastifyReply {
  const problem = buildProblem(code, reply.request.id, extra);
  if (extra.headers !== undefined) {
    reply.headers(extra.headers);
  }
  return reply.code(problem.status).type(PROBLEM_CONTENT_TYPE).send(problem);
}

/** Maps Fastify/HTTP-level failures (statusCode on the error) to the documented codes. */
function codeForStatus(status: number): ErrorCode {
  switch (status) {
    case 401:
      return 'UNAUTHENTICATED';
    case 404:
      return 'NOT_FOUND';
    case 405:
      return 'METHOD_NOT_ALLOWED';
    case 413:
      return 'PAYLOAD_TOO_LARGE';
    case 415:
      return 'UNSUPPORTED_MEDIA_TYPE';
    case 429:
      return 'RATE_LIMITED';
    default:
      return 'VALIDATION_FAILED';
  }
}

function toPath(instancePath: string): string {
  const trimmed = instancePath.replace(/^\//, '').replace(/\//g, '.');
  return trimmed === '' ? '(root)' : trimmed;
}

/**
 * Installs the single error model for the whole API: RFC 9457 `application/problem+json` with
 * `type, title, status, code, requestId` (+ optional `detail`, `errors`). Stack traces, SQL errors,
 * secrets, provider credentials, and internal paths never reach the response; unexpected errors are
 * logged (scrubbed) server-side and answered with a generic INTERNAL problem.
 */
export function installProblemHandlers(app: FastifyInstance): void {
  app.setNotFoundHandler((_request: FastifyRequest, reply: FastifyReply) => {
    return sendProblem(reply, 'NOT_FOUND');
  });

  app.setErrorHandler(
    (error: FastifyError | Error, request: FastifyRequest, reply: FastifyReply) => {
      if (error instanceof HttpProblem) {
        return sendProblem(reply, error.code, {
          ...(error.detail !== undefined ? { detail: error.detail } : {}),
          ...(error.options.errors !== undefined ? { errors: error.options.errors } : {}),
          ...(error.options.headers !== undefined ? { headers: error.options.headers } : {}),
        });
      }

      if (hasZodFastifySchemaValidationErrors(error)) {
        return sendProblem(reply, 'VALIDATION_FAILED', {
          errors: error.validation.map((issue) => ({
            path: toPath(issue.instancePath),
            message: issue.message ?? 'invalid',
          })),
        });
      }

      if (isResponseSerializationError(error)) {
        request.log.error({ err: error }, 'response failed schema validation');
        return sendProblem(reply, 'INTERNAL');
      }

      const statusCode = (error as { statusCode?: unknown }).statusCode;
      if (typeof statusCode === 'number' && statusCode >= 400 && statusCode < 500) {
        return sendProblem(reply, codeForStatus(statusCode));
      }

      request.log.error({ err: error }, 'unhandled error');
      return sendProblem(reply, 'INTERNAL');
    },
  );
}
