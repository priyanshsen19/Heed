/**
 * Extension bundle secret scan (docs/SECURITY.md section 3, "CI bundle scan").
 *
 * Fails (exit 1) if the built extension contains anything resembling a secret, or the NAME of any
 * server configuration variable or runtime secret. Fails closed (exit 2) if there is nothing to scan,
 * so a missing build can never look like a clean build. Findings print the rule and file only plus a
 * masked sample: the scanner itself must not spread a secret into CI logs.
 *
 * Usage: tsx bundle-scan.ts <dist-directory>
 */
import { readdir, readFile, stat } from 'node:fs/promises';
import { basename, extname, join, relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  RUNTIME_SECRET_NAMES,
  SECRETS_ENV_POINTERS,
  SERVER_CONFIG_VARIABLE_NAMES,
} from '@heed/config';

export interface PatternRule {
  readonly id: string;
  readonly description: string;
  readonly pattern: RegExp;
}

export interface Finding {
  readonly file: string;
  readonly rule: string;
  readonly sample: string;
}

export class ScanError extends Error {
  override readonly name = 'ScanError';
}

export const PATTERN_RULES: readonly PatternRule[] = [
  {
    id: 'google-api-key',
    description: 'Google API key (AIza...)',
    pattern: /AIza[0-9A-Za-z_-]{20,}/,
  },
  {
    id: 'google-client-secret',
    description: 'Google OAuth client secret (GOCSPX-...)',
    pattern: /GOCSPX-/,
  },
  {
    id: 'client-secret-literal',
    description: '"client_secret" literal',
    pattern: /client_secret/i,
  },
  {
    id: 'postgres-url',
    description: 'PostgreSQL connection string',
    pattern: /postgres(?:ql)?:\/\//i,
  },
  {
    id: 'pem-private-key',
    description: 'PEM private key block',
    pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  },
  {
    id: 'google-refresh-token',
    description: 'Google refresh token shape (1//...)',
    pattern: /(?<![0-9A-Za-z/])1\/\/[0-9A-Za-z_-]{20,}/,
  },
  {
    id: 'google-access-token',
    description: 'Google access token shape (ya29....)',
    pattern: /ya29\.[0-9A-Za-z_-]{20,}/,
  },
  {
    id: 'jwt',
    description: 'JSON Web Token',
    pattern: /eyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/,
  },
];

/** Generic names that are not distinctive enough to scan for (common words, not secrets). */
const EXEMPT_NAMES = new Set(['PORT', 'HOST']);

/** Secret and server variable names that must never appear in the extension, even as strings. */
export function forbiddenNames(): string[] {
  const names = new Set<string>([
    ...SERVER_CONFIG_VARIABLE_NAMES,
    ...RUNTIME_SECRET_NAMES,
    ...SECRETS_ENV_POINTERS,
    'GOOGLE_CLIENT_SECRET',
    'GEMINI_API_KEY',
    'DATABASE_URL',
    'DIRECT_URL',
    'DATA_KEY',
    'DATA_KEYS',
    'HMAC_PEPPER',
    'SESSION_SECRET',
  ]);
  return [...names].filter((name) => !EXEMPT_NAMES.has(name)).sort();
}

const TEXT_EXTENSIONS = new Set([
  '.js',
  '.mjs',
  '.cjs',
  '.html',
  '.css',
  '.json',
  '.map',
  '.txt',
  '.svg',
  '.webmanifest',
]);
const FORBIDDEN_FILENAMES =
  /^(\.env(\..*)?|\.secrets\.local\.json|.*\.(pem|key|p12|pfx)|secrets?(\..*)?)$/i;

function mask(sample: string): string {
  const head = sample.slice(0, 4);
  return `${head}${'*'.repeat(Math.max(0, Math.min(sample.length, 16) - 4))}`;
}

async function* walk(dir: string): AsyncGenerator<string> {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      yield* walk(full);
    } else if (entry.isFile()) {
      yield full;
    }
  }
}

export interface ScanResult {
  readonly filesScanned: number;
  readonly findings: readonly Finding[];
}

export async function scanDirectory(root: string): Promise<ScanResult> {
  const absolute = resolve(root);
  let info;
  try {
    info = await stat(absolute);
  } catch {
    throw new ScanError(`Bundle directory does not exist: ${root}`);
  }
  if (!info.isDirectory()) {
    throw new ScanError(`Not a directory: ${root}`);
  }

  const names = forbiddenNames();
  const nameRegexes = names.map((name) => ({
    name,
    regex: new RegExp(`(?<![A-Za-z0-9_])${name}(?![A-Za-z0-9_])`),
  }));

  const findings: Finding[] = [];
  let filesScanned = 0;

  for await (const file of walk(absolute)) {
    const rel = relative(absolute, file);
    filesScanned += 1;

    if (FORBIDDEN_FILENAMES.test(basename(file))) {
      findings.push({ file: rel, rule: 'forbidden-filename', sample: basename(file) });
    }
    if (!TEXT_EXTENSIONS.has(extname(file).toLowerCase())) {
      continue;
    }
    const content = await readFile(file, 'utf8');

    for (const rule of PATTERN_RULES) {
      const match = rule.pattern.exec(content);
      if (match) {
        findings.push({ file: rel, rule: rule.id, sample: mask(match[0]) });
      }
    }
    for (const { name, regex } of nameRegexes) {
      if (regex.test(content)) {
        findings.push({ file: rel, rule: 'server-variable-name', sample: name });
      }
    }
  }

  if (filesScanned === 0) {
    throw new ScanError(`No files found in ${root}: refusing to report a clean scan of nothing`);
  }
  return { filesScanned, findings };
}

async function main(): Promise<void> {
  const target = process.argv[2];
  if (target === undefined) {
    process.stderr.write('usage: tsx bundle-scan.ts <dist-directory>\n');
    process.exit(2);
  }
  try {
    const { filesScanned, findings } = await scanDirectory(target);
    if (findings.length > 0) {
      process.stderr.write(
        `bundle-scan: FAILED with ${String(findings.length)} finding(s) in ${String(filesScanned)} files\n`,
      );
      for (const finding of findings) {
        process.stderr.write(`  [${finding.rule}] ${finding.file} (${finding.sample})\n`);
      }
      process.exit(1);
    }
    process.stdout.write(
      `bundle-scan: OK (${String(filesScanned)} files scanned, ${String(forbiddenNames().length)} names and ${String(PATTERN_RULES.length)} patterns checked)\n`,
    );
  } catch (error) {
    process.stderr.write(
      `bundle-scan: ERROR ${error instanceof Error ? error.message : 'unknown'}\n`,
    );
    process.exit(2);
  }
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void main();
}
