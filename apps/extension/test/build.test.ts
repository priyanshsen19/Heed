// @vitest-environment node
import { execFile } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterAll, describe, expect, it } from 'vitest';
import { parsePublicConfig } from '@heed/shared';
import { buildManifest } from '../manifest.config';

const run = promisify(execFile);
const root = join(import.meta.dirname, '..');
const vite = join(root, 'node_modules/vite/bin/vite.js');
const created: string[] = [];

async function build(
  env: Record<string, string>,
): Promise<{ ok: boolean; out: string; stderr: string }> {
  const out = await mkdtemp(join(tmpdir(), 'heed-ext-'));
  created.push(out);
  try {
    await run(
      process.execPath,
      [vite, 'build', '--configLoader', 'runner', '--outDir', out, '--emptyOutDir'],
      { cwd: root, env, timeout: 90_000 },
    );
    return { ok: true, out, stderr: '' };
  } catch (error) {
    return { ok: false, out, stderr: (error as { stderr?: string }).stderr ?? '' };
  }
}

function listFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = join(dir, name);
    return statSync(full).isDirectory() ? listFiles(full) : [full];
  });
}

afterAll(async () => {
  await Promise.all(created.map((dir) => rm(dir, { recursive: true, force: true })));
});

describe('extension production build', () => {
  const env = { VITE_API_BASE_URL: 'https://api.example.test', VITE_ENV: 'production' };

  it('produces every entry point and a manifest identical to the typed configuration', async () => {
    const result = await build(env);
    expect(result.ok, result.stderr).toBe(true);
    for (const file of [
      'popup.html',
      'sidepanel.html',
      'options.html',
      'service-worker.js',
      'manifest.json',
    ]) {
      expect(existsSync(join(result.out, file)), file).toBe(true);
    }
    const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as { version: string };
    const manifest = JSON.parse(readFileSync(join(result.out, 'manifest.json'), 'utf8')) as unknown;
    expect(manifest).toEqual(buildManifest(parsePublicConfig(env), pkg.version));
  }, 120_000);

  it('contains no inline scripts, eval, or new Function (strict CSP compatible)', async () => {
    const result = await build(env);
    expect(result.ok, result.stderr).toBe(true);
    for (const file of listFiles(result.out)) {
      const text = readFileSync(file, 'utf8');
      if (file.endsWith('.html')) {
        expect(text, file).not.toMatch(/<script(?![^>]*\bsrc=)[^>]*>/i);
        expect(text, file).not.toMatch(/\son[a-z]+\s*=|javascript:/i);
      }
      if (file.endsWith('.js')) {
        expect(text, file).not.toMatch(/\beval\s*\(|new Function\s*\(/);
      }
    }
  }, 120_000);

  it('embeds no server configuration or secret names', async () => {
    const result = await build({
      ...env,
      GEMINI_API_KEY: 'k',
      DATABASE_URL: 'd',
      GOOGLE_CLIENT_SECRET: 's',
      DATA_KEYS: 'x',
      HMAC_PEPPER: 'p',
    });
    expect(result.ok, result.stderr).toBe(true);
    const bundle = listFiles(result.out)
      .map((f) => readFileSync(f, 'utf8'))
      .join('\n');
    for (const name of [
      'GEMINI_API_KEY',
      'DATABASE_URL',
      'GOOGLE_CLIENT_SECRET',
      'DATA_KEYS',
      'HMAC_PEPPER',
    ]) {
      expect(bundle, name).not.toContain(name);
    }
  }, 120_000);

  it.each([
    ['missing API URL', { VITE_ENV: 'production' }],
    ['missing environment', { VITE_API_BASE_URL: 'https://api.example.test' }],
    [
      'insecure production URL',
      { VITE_API_BASE_URL: 'http://api.example.test', VITE_ENV: 'production' },
    ],
    [
      'credentials in URL',
      { VITE_API_BASE_URL: 'https://u:p@api.example.test', VITE_ENV: 'production' },
    ],
    ['unknown environment', { VITE_API_BASE_URL: 'https://api.example.test', VITE_ENV: 'prod' }],
  ])(
    'FAILS closed on %s',
    async (_label, bad) => {
      const result = await build(bad);
      expect(result.ok).toBe(false);
      expect(result.stderr).toMatch(/Invalid public configuration/);
    },
    120_000,
  );
});
