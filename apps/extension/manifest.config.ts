/**
 * The extension manifest, generated from typed configuration at build time (docs/ARCHITECTURE.md 3.1).
 *
 * SECURITY REVIEW CHECKLIST (CODEOWNERS-protected; docs/SECURITY.md section 8):
 *  - minimum permissions only; every addition needs a DECISIONS entry
 *  - host_permissions: the Heed API origin only; never <all_urls>
 *  - NO content_scripts, NO externally_connectable, NO web_accessible_resources: web pages are hostile
 *    and must not be able to reach or script the extension
 *  - strict MV3 CSP: no unsafe-eval, no unsafe-inline, no remote code
 */
import type { PublicConfig } from '@heed/shared';

/**
 * Permissions the architecture documents for the full V1 (ARCHITECTURE 3.1). Stage 1 requests only the
 * subset it uses; later stages add `identity` (Stage 3), `alarms` and `notifications` (Stage 12).
 */
export const DOCUMENTED_PERMISSIONS = [
  'identity',
  'storage',
  'alarms',
  'notifications',
  'sidePanel',
] as const;

/** Permissions requested in this stage. */
export const STAGE_PERMISSIONS = [
  'storage',
  'sidePanel',
] as const satisfies readonly (typeof DOCUMENTED_PERMISSIONS)[number][];

export const EXTENSION_PAGES_CSP = "script-src 'self'; object-src 'self'; base-uri 'none'";

export interface ExtensionManifest {
  manifest_version: 3;
  name: string;
  short_name: string;
  version: string;
  description: string;
  minimum_chrome_version: string;
  action: { default_title: string; default_popup: string };
  side_panel: { default_path: string };
  options_ui: { page: string; open_in_tab: boolean };
  background: { service_worker: string; type: 'module' };
  permissions: string[];
  host_permissions: string[];
  content_security_policy: { extension_pages: string };
}

export function buildManifest(config: PublicConfig, version: string): ExtensionManifest {
  const nameSuffix = config.env === 'production' ? '' : ` (${config.env})`;
  return {
    manifest_version: 3,
    name: `Heed${nameSuffix}`,
    short_name: 'Heed',
    version,
    description: 'Understands what you need to do and reminds you when it matters.',
    // Side panel API requires Chrome 114+; 120 also gives stable service-worker module support.
    minimum_chrome_version: '120',
    action: { default_title: 'Heed', default_popup: 'popup.html' },
    side_panel: { default_path: 'sidepanel.html' },
    options_ui: { page: 'options.html', open_in_tab: true },
    background: { service_worker: 'service-worker.js', type: 'module' },
    permissions: [...STAGE_PERMISSIONS],
    host_permissions: [`${config.apiOrigin}/*`],
    content_security_policy: { extension_pages: EXTENSION_PAGES_CSP },
  };
}
