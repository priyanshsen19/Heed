import { execFile, spawn } from 'node:child_process';
import { createServer, type AddressInfo } from 'node:net';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';
import { generateRuntimeSecrets, loadServerConfig } from '@heed/config';
import { startServer } from '../src/server';
import { UnconfiguredRateLimiter } from '../src/ports/rate-limiter';
import { createLogger } from '../src/observability/logger';
import { createLogCapture } from '../src/testing/log-capture';
import { FakeClock } from '@heed/shared/testing';

const run = promisify(execFile);
const apiDir = join(import.meta.dirname, '..');
const tsx = join(apiDir, 'node_modules/.bin/tsx');

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as AddressInfo;
      server.close(() => {
        resolve(port);
      });
    });
    server.on('error', reject);
  });
}

describe('startServer', () => {
  it('serves over a real socket, reports not-ready while draining, and closes cleanly', async () => {
    const port = await freePort();
    const logs = createLogCapture();
    const server = await startServer({
      config: loadServerConfig({
        HEED_ENV: 'test',
        HOST: '127.0.0.1',
        PORT: String(port),
        LOG_LEVEL: 'info',
      }),
      clock: new FakeClock(),
      logger: createLogger({ level: 'info', env: 'test', destination: logs.destination }),
      rateLimiter: new UnconfiguredRateLimiter(),
      readinessChecks: [],
    });
    const base = `http://127.0.0.1:${String(port)}`;
    expect((await fetch(`${base}/healthz`)).status).toBe(200);
    expect((await fetch(`${base}/readyz`)).status).toBe(200);
    server.drain();
    expect((await fetch(`${base}/readyz`)).status).toBe(503);
    expect((await fetch(`${base}/healthz`)).status).toBe(200);
    await server.close();
    await expect(fetch(`${base}/healthz`)).rejects.toThrow();
  });
});

describe('main.ts fails closed', () => {
  async function startMain(env: Record<string, string>) {
    try {
      await run(tsx, ['src/main.ts'], { cwd: apiDir, env, timeout: 30_000 });
      return { code: 0, stderr: '' };
    } catch (error: unknown) {
      const failure = error as { code?: number; stderr?: string };
      return { code: failure.code ?? 1, stderr: failure.stderr ?? '' };
    }
  }

  it('refuses to start with no configuration, naming variables but exposing no stack', async () => {
    const result = await startMain({});
    expect(result.code).toBe(1);
    const line = JSON.parse(result.stderr.trim().split('\n').pop() ?? '{}') as Record<
      string,
      string
    >;
    expect(line['msg']).toBe('startup failed');
    expect(line['reason']).toContain('HEED_ENV');
    expect(result.stderr).not.toMatch(/\n\s+at /);
  });

  it('refuses to start with malformed configuration and does not echo the value', async () => {
    const result = await startMain({
      HEED_ENV: 'local',
      PORT: 'definitely-not-a-port-SECRETVALUE',
    });
    expect(result.code).toBe(1);
    expect(result.stderr).toContain('PORT');
    expect(result.stderr).not.toContain('SECRETVALUE');
  });

  it('refuses to start without a runtime secrets source', async () => {
    const result = await startMain({ HEED_ENV: 'local' });
    expect(result.code).toBe(1);
    expect(result.stderr).toContain('HEED_RUNTIME_SECRETS');
  });

  it('refuses to start with invalid secrets and never prints them', async () => {
    const result = await startMain({
      HEED_ENV: 'local',
      HEED_RUNTIME_SECRETS_JSON: JSON.stringify({ HMAC_PEPPER: 'LEAKCHECKvalue123456789' }),
    });
    expect(result.code).toBe(1);
    expect(result.stderr).toContain('Invalid runtime secrets');
    expect(result.stderr).not.toContain('LEAKCHECKvalue');
  });

  it('starts with valid config, answers /healthz and /readyz, and exits 0 on SIGTERM', async () => {
    const port = await freePort();
    const child = spawn(tsx, ['src/main.ts'], {
      cwd: apiDir,
      env: {
        HEED_ENV: 'local',
        HOST: '127.0.0.1',
        PORT: String(port),
        HEED_RUNTIME_SECRETS_JSON: JSON.stringify(generateRuntimeSecrets()),
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    const exited = new Promise<number | null>((resolve) => child.once('exit', resolve));
    try {
      const base = `http://127.0.0.1:${String(port)}`;
      let up = false;
      for (let i = 0; i < 100 && !up; i += 1) {
        up = await fetch(`${base}/healthz`).then(
          (r) => r.ok,
          () => false,
        );
        if (!up) {
          await new Promise((r) => setTimeout(r, 100));
        }
      }
      expect(up).toBe(true);
      expect((await fetch(`${base}/readyz`)).status).toBe(200);
      child.kill('SIGTERM');
      expect(await exited).toBe(0);
      expect(stdout).toContain('heed-api started');
    } finally {
      child.kill('SIGKILL');
    }
  }, 40_000);
});
