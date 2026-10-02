import type { ZodError } from 'zod';

/**
 * Configuration failure. The message lists variable names and issue codes only: never the offending
 * value, because a malformed value may be a secret.
 */
export class ConfigError extends Error {
  override readonly name = 'ConfigError';
}

export function describeIssues(error: ZodError): string {
  return error.issues
    .map((issue) => {
      const path = issue.path.length > 0 ? issue.path.join('.') : '(root)';
      const note = issue.code === 'custom' ? issue.message : issue.code;
      return `${path}: ${note}`;
    })
    .join('; ');
}
