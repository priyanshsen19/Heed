import { readdirSync, readFileSync, statSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createApp } from '../src/app';
import { buildHarness } from '../src/testing/test-deps';

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = join(dir, name);
    return statSync(full).isDirectory() ? sourceFiles(full) : full.endsWith('.ts') ? [full] : [];
  });
}

const srcRoot = join(import.meta.dirname, '../src');
const productionFiles = sourceFiles(srcRoot).filter(
  (f) => !relative(srcRoot, f).startsWith('testing/'),
);

describe('statelessness: behavior never depends on which instance serves a request', () => {
  it('N identical instances answer identically, in any order', async () => {
    const instances = await Promise.all(
      Array.from({ length: 10 }, () =>
        createApp(
          buildHarness({ readinessChecks: [{ name: 'ok', check: () => Promise.resolve(true) }] })
            .deps,
        ),
      ),
    );
    const bodies = new Set<string>();
    for (let round = 0; round < 3; round += 1) {
      for (const app of [...instances].reverse()) {
        for (const url of ['/healthz', '/readyz']) {
          const res = await app.inject({ method: 'GET', url });
          bodies.add(`${url}:${String(res.statusCode)}:${res.body}`);
        }
      }
    }
    expect([...bodies].sort()).toEqual([
      '/healthz:200:{"status":"ok"}',
      '/readyz:200:{"status":"ready"}',
    ]);
    await Promise.all(instances.map((app) => app.close()));
  });

  it('a restarted instance behaves identically (no state to lose)', async () => {
    const first = await createApp(buildHarness().deps);
    const before = await first.inject({ method: 'GET', url: '/readyz' });
    await first.close();
    const second = await createApp(buildHarness().deps);
    const after = await second.inject({ method: 'GET', url: '/readyz' });
    expect(after.statusCode).toBe(before.statusCode);
    expect(after.body).toBe(before.body);
    await second.close();
  });

  it('two real servers on different ports serve identical responses over HTTP', async () => {
    const [a, b] = await Promise.all([
      createApp(buildHarness().deps),
      createApp(buildHarness().deps),
    ]);
    await Promise.all([
      a.listen({ port: 0, host: '127.0.0.1' }),
      b.listen({ port: 0, host: '127.0.0.1' }),
    ]);
    const urls = [a, b].map(
      (app) => `http://127.0.0.1:${String((app.server.address() as AddressInfo).port)}`,
    );
    const results = await Promise.all(
      urls.map(async (url) => (await fetch(`${url}/healthz`)).text()),
    );
    expect(results[0]).toBe(results[1]);
    await Promise.all([a.close(), b.close()]);
  });

  it('production code uses no process-local timers, local file writes, or module-level state', () => {
    const forbidden: [RegExp, string][] = [
      [/\bsetInterval\s*\(/, 'setInterval'],
      [
        /\b(writeFile|writeFileSync|appendFile|appendFileSync|createWriteStream)\b/,
        'local file write',
      ],
      [/^(export\s+)?let\s/m, 'module-level let'],
      [
        /^(export\s+)?const\s+\w+\s*(:[^=]+)?=\s*new\s+(Map|Set|WeakMap)\b/m,
        'module-level Map/Set',
      ],
      [/\bglobalThis\.\w+\s*=/, 'globalThis mutation'],
    ];
    for (const file of productionFiles) {
      const text = readFileSync(file, 'utf8');
      for (const [pattern, label] of forbidden) {
        expect(pattern.test(text), `${relative(srcRoot, file)} uses ${label}`).toBe(false);
      }
    }
  });

  it('only main.ts reads process.env, and only the Clock reads the real time', () => {
    for (const file of productionFiles) {
      const rel = relative(srcRoot, file);
      const text = readFileSync(file, 'utf8');
      if (rel !== 'main.ts') {
        expect(text, `${rel} reads process.env`).not.toMatch(/process\.env/);
      }
      expect(text, `${rel} uses raw Date`).not.toMatch(/new Date\(\)|Date\.now\(\)/);
    }
  });
});
