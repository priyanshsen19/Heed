import { describe, expect, it } from 'vitest';
import { parsePublicConfig } from '@heed/shared';
import {
  DOCUMENTED_PERMISSIONS,
  EXTENSION_PAGES_CSP,
  STAGE_PERMISSIONS,
  buildManifest,
} from '../manifest.config';

const config = parsePublicConfig({
  VITE_API_BASE_URL: 'https://api.example.test',
  VITE_ENV: 'production',
});
const manifest = buildManifest(config, '1.2.3');

describe('manifest (typed, generated)', () => {
  it('is Manifest V3 with a module service worker, popup, side panel, and options page', () => {
    expect(manifest.manifest_version).toBe(3);
    expect(manifest.background).toEqual({ service_worker: 'service-worker.js', type: 'module' });
    expect(manifest.action.default_popup).toBe('popup.html');
    expect(manifest.side_panel.default_path).toBe('sidepanel.html');
    expect(manifest.options_ui.page).toBe('options.html');
    expect(manifest.version).toBe('1.2.3');
  });

  it('requests only the permissions this stage uses, all from the documented list', () => {
    expect([...manifest.permissions].sort()).toEqual(['sidePanel', 'storage']);
    expect(STAGE_PERMISSIONS.every((p) => DOCUMENTED_PERMISSIONS.includes(p))).toBe(true);
    for (const forbidden of [
      'tabs',
      'activeTab',
      'scripting',
      'webRequest',
      'cookies',
      'history',
      'unlimitedStorage',
      'identity',
      'alarms',
      'notifications',
    ]) {
      expect(manifest.permissions, forbidden).not.toContain(forbidden);
    }
  });

  it('limits host permissions to exactly the API origin (never <all_urls> or wildcards)', () => {
    expect(manifest.host_permissions).toEqual(['https://api.example.test/*']);
    const serialized = JSON.stringify(manifest);
    expect(serialized).not.toContain('<all_urls>');
    expect(serialized).not.toContain('*://');
    expect(serialized).not.toContain('http://*/');
  });

  it('has no content scripts, externally_connectable, or web_accessible_resources: web pages are hostile', () => {
    const keys = Object.keys(manifest);
    for (const forbidden of [
      'content_scripts',
      'externally_connectable',
      'web_accessible_resources',
      'optional_host_permissions',
      'declarative_net_request',
      'devtools_page',
      'chrome_url_overrides',
    ]) {
      expect(keys, forbidden).not.toContain(forbidden);
    }
  });

  it('uses a strict extension-pages CSP without unsafe-eval or unsafe-inline or remote sources', () => {
    const csp = manifest.content_security_policy.extension_pages;
    expect(csp).toBe(EXTENSION_PAGES_CSP);
    expect(csp).not.toMatch(/unsafe-eval|unsafe-inline|wasm-unsafe-eval|https?:|\*/);
    expect(csp).toContain("script-src 'self'");
    expect(csp).toContain("object-src 'self'");
  });

  it('labels non-production builds and keeps the name clean in production', () => {
    expect(manifest.name).toBe('Heed');
    const staging = buildManifest(
      parsePublicConfig({
        VITE_API_BASE_URL: 'https://api-staging.example.test',
        VITE_ENV: 'staging',
      }),
      '0.0.1',
    );
    expect(staging.name).toBe('Heed (staging)');
    expect(staging.host_permissions).toEqual(['https://api-staging.example.test/*']);
  });

  it('uses a valid Chrome version string', () => {
    expect(buildManifest(config, '0.0.1').version).toMatch(/^\d+(\.\d+){0,3}$/);
  });
});
