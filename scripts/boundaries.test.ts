import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const repoRoot = resolve(import.meta.dirname, '..');
const config = join(repoRoot, '.dependency-cruiser.cjs');
const depcruise = join(repoRoot, 'node_modules/.bin/depcruise');
const created: string[] = [];

interface Violation {
  readonly rule: { readonly name: string; readonly severity: string };
  readonly from: string;
  readonly to: string;
}

async function workspace(files: Record<string, string>): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'heed-boundary-'));
  created.push(dir);
  await writeFile(
    join(dir, 'tsconfig.base.json'),
    '{"compilerOptions":{"module":"ESNext","moduleResolution":"Bundler"}}',
  );
  for (const [name, content] of Object.entries(files)) {
    const target = join(dir, name);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, content);
  }
  return dir;
}

function cruise(cwd: string, targets: string[]): { exitCode: number; violations: Violation[] } {
  // Exit code: exactly what CI sees (default reporter). The JSON reporter always exits 0, so the
  // violation list comes from a second, JSON run.
  let exitCode = 0;
  try {
    execFileSync(depcruise, [...targets, '--config', config], { cwd, stdio: 'ignore' });
  } catch (error) {
    exitCode = (error as { status?: number }).status ?? 1;
  }
  const out = execFileSync(depcruise, [...targets, '--config', config, '--output-type', 'json'], {
    cwd,
    encoding: 'utf8',
  });
  const parsed = JSON.parse(out) as { summary: { violations: Violation[] } };
  return { exitCode, violations: parsed.summary.violations };
}

const rulesOf = (violations: Violation[]): string[] => violations.map((v) => v.rule.name);

afterEach(async () => {
  await Promise.all(created.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe('architecture boundaries (dependency-cruiser)', () => {
  it('the real repository satisfies every boundary rule', () => {
    const { exitCode, violations } = cruise(repoRoot, ['apps', 'packages', 'scripts']);
    expect(violations.filter((v) => v.rule.severity === 'error')).toEqual([]);
    expect(exitCode).toBe(0);
  });

  it('accepts the allowed directions', async () => {
    const dir = await workspace({
      'packages/shared/src/index.ts': 'export const a = 1;',
      'packages/config/src/index.ts':
        "import { a } from '../../shared/src/index'; export const b = a;",
      'apps/api/src/main.ts':
        "import { b } from '../../../packages/config/src/index'; import { a } from '../../../packages/shared/src/index'; export const c = a + b;",
      'apps/extension/src/popup.ts':
        "import { a } from '../../../packages/shared/src/index'; export const d = a;",
    });
    const result = cruise(dir, ['apps', 'packages']);
    expect(result.violations).toEqual([]);
    expect(result.exitCode).toBe(0);
  });

  it('FAILS when the extension imports API code', async () => {
    const dir = await workspace({
      'apps/api/src/secret.ts': 'export const s = 1;',
      'apps/extension/src/popup.ts':
        "import { s } from '../../api/src/secret'; export const x = s;",
    });
    const result = cruise(dir, ['apps']);
    expect(rulesOf(result.violations)).toContain('extension-may-import-only-shared');
    expect(result.exitCode).not.toBe(0);
  });

  it('FAILS when the extension imports server configuration', async () => {
    const dir = await workspace({
      'packages/config/src/index.ts': 'export const c = 1;',
      'apps/extension/src/popup.ts':
        "import { c } from '../../../packages/config/src/index'; export const x = c;",
    });
    const result = cruise(dir, ['apps', 'packages']);
    expect(rulesOf(result.violations)).toContain('extension-may-import-only-shared');
    expect(result.exitCode).not.toBe(0);
  });

  it('FAILS when the extension imports Node built-ins', async () => {
    const dir = await workspace({
      'apps/extension/src/popup.ts':
        "import { readFileSync } from 'node:fs'; export const x = readFileSync;",
    });
    const result = cruise(dir, ['apps']);
    expect(rulesOf(result.violations)).toContain('extension-no-node-builtins');
  });

  it.each(['fastify', 'pino', '@prisma/client', 'googleapis', '@google/genai', 'jose'])(
    'FAILS when the extension bundles server/provider library %s',
    async (pkg) => {
      const dir = await workspace({
        [`node_modules/${pkg}/package.json`]: JSON.stringify({ name: pkg, main: 'index.js' }),
        [`node_modules/${pkg}/index.js`]: 'module.exports = {};',
        'apps/extension/src/popup.ts': `import lib from '${pkg}'; export const x = lib;`,
      });
      const result = cruise(dir, ['apps']);
      expect(rulesOf(result.violations)).toContain('extension-no-server-npm-modules');
      expect(result.exitCode).not.toBe(0);
    },
  );

  it('FAILS when server code imports the extension', async () => {
    const dir = await workspace({
      'apps/extension/src/popup.ts': 'export const ui = 1;',
      'apps/api/src/main.ts':
        "import { ui } from '../../extension/src/popup'; export const x = ui;",
    });
    const result = cruise(dir, ['apps']);
    expect(rulesOf(result.violations)).toContain('server-must-not-import-extension');
  });

  it('FAILS when packages/shared is not a leaf', async () => {
    const dir = await workspace({
      'packages/config/src/index.ts': 'export const c = 1;',
      'packages/shared/src/index.ts':
        "import { c } from '../../config/src/index'; export const x = c;",
    });
    const result = cruise(dir, ['packages']);
    expect(rulesOf(result.violations)).toContain('shared-is-a-leaf');
  });

  it('FAILS on circular dependencies', async () => {
    const dir = await workspace({
      'packages/shared/src/a.ts': "import { b } from './b'; export const a = () => b;",
      'packages/shared/src/b.ts': "import { a } from './a'; export const b = () => a;",
    });
    expect(rulesOf(cruise(dir, ['packages']).violations)).toContain('no-circular');
  });

  it('FAILS when production code imports a test double', async () => {
    const dir = await workspace({
      'packages/shared/src/testing.ts': 'export class FakeClock {}',
      'apps/api/src/main.ts':
        "import { FakeClock } from '../../../packages/shared/src/testing'; export const x = FakeClock;",
    });
    expect(rulesOf(cruise(dir, ['apps', 'packages']).violations)).toContain(
      'no-test-helpers-in-production',
    );
  });
});
