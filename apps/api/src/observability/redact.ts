/**
 * Log scrubbing. Two independent layers, because "never log email content, addresses, tokens, keys,
 * prompts, or secrets" must hold even when a developer logs the wrong thing under an innocent key:
 *
 *  1. KEY-based: values under sensitive keys (body, subject, email, token, authorization, ...) are replaced.
 *  2. VALUE-based: every remaining string is pattern-scrubbed (email addresses, bearer tokens, JWTs,
 *     Google token/key shapes, connection strings, URL credentials, long opaque tokens).
 *
 * Both layers run inside the logger (logMethod hook), so they cover every call site, including
 * `request.log`, error objects, and message strings. See test/log-canary.test.ts.
 */

export const REDACTED = '[REDACTED]';

/** Substrings of normalized keys (lowercase alphanumerics) that mark a value as secret or private. */
const SENSITIVE_KEY_PARTS = [
  // credentials and secrets
  'token',
  'secret',
  'password',
  'passwd',
  'apikey',
  'authorization',
  'cookie',
  'credential',
  'privatekey',
  'pepper',
  'datakey',
  'databaseurl',
  'dsn',
  'verifier',
  'bearer',
  'session',
  // private content: mail, prompts, personal data
  'body',
  'subject',
  'email',
  'recipient',
  'sender',
  'prompt',
  'snippet',
  'excerpt',
  'quote',
  'content',
  'payload',
];

/** Short generic keys that are private only when matched exactly (substring matching would over-redact). */
const SENSITIVE_KEYS_EXACT: readonly string[] = [
  'from',
  'to',
  'cc',
  'bcc',
  'text',
  'html',
  'completion',
  'response',
  'input',
  'output',
  'headers',
  'query',
  'url',
];

/** Keys that carry correlation ids; their values are exempt from opaque-token scrubbing. */
const CORRELATION_KEYS: readonly string[] = ['requestid', 'reqid', 'traceid', 'correlationid'];

const MAX_DEPTH = 6;
const MAX_KEYS = 50;
const MAX_ARRAY = 50;
const MAX_STRING = 1000;
const PROSE_MIN_LENGTH = 160;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ISO_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T[\d:.]+Z$/;

const normalizeKey = (key: string): string => key.toLowerCase().replace(/[^a-z0-9]/g, '');

export function isSensitiveKey(key: string): boolean {
  const normalized = normalizeKey(key);
  if (CORRELATION_KEYS.includes(normalized)) {
    return false;
  }
  return (
    SENSITIVE_KEYS_EXACT.includes(normalized) ||
    SENSITIVE_KEY_PARTS.some((part) => normalized.includes(part))
  );
}

const STRING_RULES: readonly (readonly [RegExp, string])[] = [
  [/postgres(?:ql)?:\/\/\S+/gi, '[db-url]'],
  [/\b[a-z][a-z0-9+.-]*:\/\/[^\s/:@]+:[^\s/@]+@/gi, '://[REDACTED]@'],
  [/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, 'Bearer [REDACTED]'],
  [/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g, '[jwt]'],
  [/\bAIza[0-9A-Za-z_-]{20,}/g, '[secret]'],
  [/GOCSPX-[0-9A-Za-z_-]+/g, '[secret]'],
  [/\bya29\.[0-9A-Za-z_-]{10,}/g, '[secret]'],
  [/(?<![0-9A-Za-z/])1\/\/[0-9A-Za-z_-]{10,}/g, '[secret]'],
  [
    /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g,
    '[private-key]',
  ],
  [/[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/g, '[email]'],
];

const LONG_OPAQUE = /[A-Za-z0-9+/_-]{32,}={0,2}/g;

/** Long natural-language text (an email body, a prompt) is never a legitimate structured-log value. */
function looksLikeProse(value: string): boolean {
  if (value.length < PROSE_MIN_LENGTH) {
    return false;
  }
  const spaces = value.split(' ').length - 1;
  return spaces / value.length > 0.1;
}

/** Scrubs secret-shaped substrings and prose from free text. */
export function scrubString(
  input: string,
  options: { keepOpaque?: boolean; allowProse?: boolean } = {},
): string {
  if (options.allowProse !== true && looksLikeProse(input)) {
    return `[text redacted: ${String(input.length)} chars]`;
  }
  let out = input.length > MAX_STRING ? `${input.slice(0, MAX_STRING)}…` : input;
  for (const [pattern, replacement] of STRING_RULES) {
    out = out.replace(pattern, replacement);
  }
  if (options.keepOpaque !== true) {
    out = out.replace(LONG_OPAQUE, (match) =>
      UUID.test(match) || ISO_TIMESTAMP.test(match) ? match : '[opaque]',
    );
  }
  return out;
}

function sanitizeError(
  error: Error,
  depth: number,
  seen: WeakSet<object>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {
    type: error.name,
    message: scrubString(error.message),
  };
  if (typeof error.stack === 'string') {
    out['stack'] = scrubString(error.stack.split('\n').slice(0, 20).join('\n'), {
      keepOpaque: true,
      allowProse: true,
    });
  }
  const code = (error as { code?: unknown }).code;
  if (typeof code === 'string') {
    out['code'] = scrubString(code);
  }
  if (error.cause !== undefined && depth < MAX_DEPTH) {
    out['cause'] = sanitize(error.cause, depth + 1, seen);
  }
  return out;
}

/** Returns a deep copy that is safe to write to logs. Never throws. */
export function sanitize(
  value: unknown,
  depth = 0,
  seen: WeakSet<object> = new WeakSet(),
): unknown {
  if (value === null || value === undefined) {
    return value;
  }
  switch (typeof value) {
    case 'string':
      return scrubString(value);
    case 'number':
    case 'boolean':
      return value;
    case 'bigint':
      return value.toString();
    case 'function':
    case 'symbol':
      return undefined;
    default:
      break;
  }

  const object = value;
  if (seen.has(object)) {
    return '[circular]';
  }
  if (depth >= MAX_DEPTH) {
    return '[truncated]';
  }
  seen.add(object);

  if (object instanceof Error) {
    return sanitizeError(object, depth, seen);
  }
  if (object instanceof Uint8Array || ArrayBuffer.isView(object)) {
    return '[binary]';
  }
  if (object instanceof Date) {
    return object.toISOString();
  }
  if (object instanceof Map || object instanceof Set) {
    return '[collection]';
  }
  if (Array.isArray(object)) {
    return object.slice(0, MAX_ARRAY).map((item) => sanitize(item, depth + 1, seen));
  }

  const out: Record<string, unknown> = {};
  let count = 0;
  for (const [key, child] of Object.entries(object as Record<string, unknown>)) {
    if (count >= MAX_KEYS) {
      out['…'] = '[truncated]';
      break;
    }
    count += 1;
    if (isSensitiveKey(key)) {
      out[key] = REDACTED;
    } else if (typeof child === 'string' && CORRELATION_KEYS.includes(normalizeKey(key))) {
      out[key] = scrubString(child, { keepOpaque: true });
    } else {
      out[key] = sanitize(child, depth + 1, seen);
    }
  }
  return out;
}
