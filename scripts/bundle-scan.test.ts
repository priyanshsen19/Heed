import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { PATTERN_RULES, ScanError, forbiddenNames, scanDirectory } from './bundle-scan';

const created: string[] = [];

async function bundle(files: Record<string, string>): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'heed-bundle-'));
  created.push(dir);
  for (const [name, content] of Object.entries(files)) {
    const target = join(dir, name);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, content);
  }
  return dir;
}

afterEach(async () => {
  await Promise.all(created.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

// Planted secrets are assembled from fragments at runtime so no realistic secret is committed.
const planted: Record<string, string> = {
  'google-api-key': 'AI' + 'za' + 'SyA-1234567890abcdefghijklmnopqrstuv',
  'google-client-secret': 'GOC' + 'SPX-' + 'abcdefghijklmnopqrstuvwxyz12',
  'client-secret-literal': 'const client' + '_secret = "x";',
  'postgres-url': 'post' + 'gres://user:pw@db.internal:5432/heed',
  'pem-private-key': '-----BEGIN ' + 'PRIVATE KEY-----\nMIIE...\n',
  'google-refresh-token': 'token="1/' + '/0gAbCdEfGhIjKlMnOpQrStUvWxYz0123456789"',
  'google-access-token': 'ya' + '29.a0AbCdEfGhIjKlMnOpQrStUvWxYz0123456789',
  jwt: 'eyJhbGciOiJIUzI1NiJ9' + '.eyJzdWIiOiIxMjM0NTY3ODkwIn0' + '.abcdefghijklmnop1234',
};

describe('bundle scan', () => {
  it('passes the committed safe fixture', async () => {
    const result = await scanDirectory(join(import.meta.dirname, '__fixtures__/bundle-scan/safe'));
    expect(result.findings).toEqual([]);
    expect(result.filesScanned).toBeGreaterThan(0);
  });

  it.each(PATTERN_RULES.map((rule) => rule.id))('fails on a planted %s', async (ruleId) => {
    const dir = await bundle({
      'assets/app.js': `console.log(${JSON.stringify('x')});\n${planted[ruleId]}\n`,
    });
    const { findings } = await scanDirectory(dir);
    expect(findings.map((f) => f.rule)).toContain(ruleId);
  });

  it('has a planted case for every pattern rule', () => {
    expect(Object.keys(planted).sort()).toEqual(PATTERN_RULES.map((r) => r.id).sort());
  });

  it('fails when a server variable or runtime secret NAME appears', async () => {
    for (const name of [
      'GEMINI_API_KEY',
      'GOOGLE_CLIENT_SECRET',
      'DATABASE_URL',
      'HMAC_PEPPER',
      'DATA_KEYS',
      'CORS_ALLOWED_ORIGINS',
      'HEED_RUNTIME_SECRETS_FILE',
    ]) {
      const dir = await bundle({ 'a.js': `var x = "${name}";` });
      const { findings } = await scanDirectory(dir);
      expect(
        findings.some((f) => f.rule === 'server-variable-name' && f.sample === name),
        name,
      ).toBe(true);
    }
  });

  it('does not flag public configuration names or common words', async () => {
    const dir = await bundle({
      'a.js':
        'var a = "VITE_API_BASE_URL", b = "VITE_ENV", c = "HOST", d = "PORT", e = "SUPPORTING";',
    });
    expect((await scanDirectory(dir)).findings).toEqual([]);
  });

  it('flags secret-bearing file names', async () => {
    const dir = await bundle({ '.env.production': 'X=1', 'key.pem': 'x' });
    const rules = (await scanDirectory(dir)).findings.map((f) => f.rule);
    expect(rules.filter((r) => r === 'forbidden-filename')).toHaveLength(2);
  });

  it('never prints the full secret', async () => {
    const dir = await bundle({ 'a.js': planted['google-api-key'] ?? '' });
    const { findings } = await scanDirectory(dir);
    for (const finding of findings) {
      expect(finding.sample).not.toContain('SyA-1234567890');
    }
  });

  it('scans nested directories and source maps', async () => {
    const dir = await bundle({ 'assets/deep/chunk.js.map': planted['postgres-url'] ?? '' });
    expect((await scanDirectory(dir)).findings.map((f) => f.rule)).toContain('postgres-url');
  });

  it('fails closed on a missing or empty directory', async () => {
    await expect(scanDirectory('/definitely/not/here')).rejects.toThrow(ScanError);
    const empty = await bundle({});
    await expect(scanDirectory(empty)).rejects.toThrow(/refusing to report a clean scan/);
  });

  it('forbids at least the documented secret names', () => {
    expect(forbiddenNames()).toEqual(
      expect.arrayContaining([
        'GOOGLE_CLIENT_SECRET',
        'GEMINI_API_KEY',
        'DATABASE_URL',
        'DATA_KEY',
        'HMAC_PEPPER',
      ]),
    );
  });
});
