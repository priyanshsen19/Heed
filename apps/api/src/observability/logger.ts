import { pino, stdTimeFunctions, type DestinationStream, type Logger } from 'pino';
import { sanitize, scrubString } from './redact';

export type { Logger } from 'pino';

export interface LoggerOptions {
  readonly level: string;
  readonly env: string;
  /** Defaults to stdout. Tests pass an in-memory stream. */
  readonly destination?: DestinationStream;
}

/**
 * Structured JSON logger. Every log call (including children such as `request.log`) passes through
 * `sanitize`/`scrubString` before serialization, so sensitive content cannot be written regardless
 * of call site. Cloud Logging understands the `severity` field.
 */
export function createLogger(options: LoggerOptions): Logger {
  return pino(
    {
      level: options.level,
      base: { service: 'heed-api', env: options.env },
      timestamp: stdTimeFunctions.isoTime,
      messageKey: 'msg',
      formatters: {
        level(label) {
          return { level: label, severity: label.toUpperCase() };
        },
      },
      redact: {
        paths: [
          'req.headers.authorization',
          'req.headers.cookie',
          'res.headers["set-cookie"]',
          '*.authorization',
          '*.cookie',
          '*.password',
          '*.token',
          '*.apiKey',
        ],
        censor: '[REDACTED]',
      },
      hooks: {
        logMethod(args, method) {
          const safe = args.map((arg) =>
            typeof arg === 'string' ? scrubString(arg) : sanitize(arg),
          );
          // pino's overloads are not expressible for a mapped tuple; arguments keep their positions.
          method.apply(this, safe as Parameters<typeof method>);
        },
      },
    },
    options.destination,
  );
}
