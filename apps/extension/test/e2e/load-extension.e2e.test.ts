// @vitest-environment node
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import {
  chromium,
  type BrowserContext,
  type ConsoleMessage,
  type Page,
  type Worker,
} from 'playwright-core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

/**
 * Loads the REAL production build into a real Chromium and verifies Chrome accepts the manifest, the
 * service worker starts, and every page renders its empty state with no console errors or CSP violations.
 */
const run = promisify(execFile);
const root = join(import.meta.dirname, '../..');
const vite = join(root, 'node_modules/vite/bin/vite.js');

let context: BrowserContext;
let outDir: string;
let userDataDir: string;
let worker: Worker;
let extensionId: string;
let webServer: Server;
const problems: string[] = [];

function watch(page: Page): void {
  page.on('console', (message: ConsoleMessage) => {
    if (message.type() === 'error' || message.type() === 'warning') {
      problems.push(`${message.type()}: ${message.text()}`);
    }
  });
  page.on('pageerror', (error) => problems.push(`pageerror: ${error.message}`));
}

function chromiumPath(): string | undefined {
  return ['/opt/pw-browsers/chromium', chromium.executablePath()].find((candidate) =>
    existsSync(candidate),
  );
}

beforeAll(async () => {
  outDir = await mkdtemp(join(tmpdir(), 'heed-e2e-dist-'));
  userDataDir = await mkdtemp(join(tmpdir(), 'heed-e2e-profile-'));
  await run(
    process.execPath,
    [vite, 'build', '--configLoader', 'runner', '--outDir', outDir, '--emptyOutDir'],
    {
      cwd: root,
      env: { VITE_API_BASE_URL: 'http://localhost:8787', VITE_ENV: 'test' },
    },
  );

  webServer = createServer((_req, res) => {
    res.setHeader('content-type', 'text/html');
    res.end('<!doctype html><title>hostile page</title><p>hello</p>');
  });
  await new Promise<void>((resolve) => webServer.listen(0, '127.0.0.1', resolve));

  context = await chromium.launchPersistentContext(userDataDir, {
    ...(chromiumPath() !== undefined ? { executablePath: chromiumPath() as string } : {}),
    headless: true,
    args: [
      `--disable-extensions-except=${outDir}`,
      `--load-extension=${outDir}`,
      '--no-sandbox',
      '--disable-gpu',
    ],
  });
  worker =
    context.serviceWorkers()[0] ??
    (await context.waitForEvent('serviceworker', { timeout: 30_000 }));
  extensionId = new URL(worker.url()).host;
});

afterAll(async () => {
  await context.close();
  webServer.close();
  await Promise.all([
    rm(outDir, { recursive: true, force: true }),
    rm(userDataDir, { recursive: true, force: true }),
  ]);
});

describe('extension loads in Chrome', () => {
  it('starts the module service worker from the manifest', () => {
    expect(worker.url()).toBe(`chrome-extension://${extensionId}/service-worker.js`);
    expect(extensionId).toMatch(/^[a-p]{32}$/);
  });

  it('exposes exactly the minimal manifest to Chrome', async () => {
    const page = await context.newPage();
    await page.goto(`chrome-extension://${extensionId}/popup.html`);
    const manifest = await page.evaluate(() => chrome.runtime.getManifest());
    await page.close();
    expect(manifest.manifest_version).toBe(3);
    expect([...(manifest.permissions ?? [])].sort()).toEqual(['sidePanel', 'storage']);
    expect(manifest.host_permissions).toEqual(['http://localhost:8787/*']);
    expect(manifest).not.toHaveProperty('content_scripts');
    expect(manifest).not.toHaveProperty('externally_connectable');
    expect(manifest.content_security_policy).toEqual({
      extension_pages: "script-src 'self'; object-src 'self'; base-uri 'none'",
    });
  });

  it('ran the install lifecycle handler (local state schema version recorded)', async () => {
    await expect
      .poll(
        () =>
          worker.evaluate(
            async () => (await chrome.storage.local.get('schemaVersion'))['schemaVersion'],
          ),
        { timeout: 10_000 },
      )
      .toBe(1);
  });

  it('holds no credentials after install', async () => {
    const all = await worker.evaluate(() => chrome.storage.local.get(null));
    expect(Object.keys(all)).toEqual(['schemaVersion']);
  });

  for (const [name, heading, expected] of [
    ['popup.html', 'Not connected', 'Not connected'],
    ['sidepanel.html', 'Upcoming', 'Nothing to show yet.'],
    ['options.html', 'About this build', 'Version'],
  ] as const) {
    it(`renders ${name} with its empty state, no console errors, and no CSP violations`, async () => {
      const page = await context.newPage();
      watch(page);
      await page.goto(`chrome-extension://${extensionId}/${name}`);
      await page.getByRole('heading', { name: heading }).waitFor({ timeout: 15_000 });
      expect(await page.locator('body').innerText()).toContain(expected);
      expect(await page.locator('body').innerText()).not.toMatch(
        /interview|assignment|reminder due/i,
      );
      await page.close();
      expect(problems.filter((p) => /content security policy|refused to|violat/i.test(p))).toEqual(
        [],
      );
    });
  }

  it('options page reports the build environment and API origin', async () => {
    const page = await context.newPage();
    await page.goto(`chrome-extension://${extensionId}/options.html`);
    await page.getByText('http://localhost:8787').waitFor({ timeout: 15_000 });
    expect(await page.locator('dl').innerText()).toContain('test');
    await page.close();
  });

  it('produced no console errors or warnings on any page', () => {
    expect(problems).toEqual([]);
  });

  it('is unreachable from a hostile web page (no externally_connectable)', async () => {
    const page = await context.newPage();
    await page.goto(`http://127.0.0.1:${String((webServer.address() as AddressInfo).port)}/`);
    const reachable = await page.evaluate((id) => {
      const api = (globalThis as { chrome?: { runtime?: { sendMessage?: unknown } } }).chrome;
      return typeof api?.runtime?.sendMessage === 'function'
        ? `sendMessage-available:${id}`
        : 'no-runtime-api';
    }, extensionId);
    expect(reachable).toBe('no-runtime-api');
    await page.close();
  });

  it('answers the typed status message from its own pages only', async () => {
    const page = await context.newPage();
    await page.goto(`chrome-extension://${extensionId}/popup.html`);
    const reply = await page.evaluate(() => chrome.runtime.sendMessage({ type: 'status/get' }));
    expect(reply).toEqual({ ok: true, status: 'not_connected' });
    const invalid = await page.evaluate(() =>
      chrome.runtime.sendMessage({ type: 'status/get', extra: true }),
    );
    expect(invalid).toEqual({ ok: false, error: 'invalid_message' });
    await page.close();
  });
});
