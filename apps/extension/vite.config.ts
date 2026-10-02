import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import react from '@vitejs/plugin-react';
import { defineConfig, loadEnv, type Plugin } from 'vite';
import { PUBLIC_CONFIG_VARIABLE_NAMES, parsePublicConfig } from '@heed/shared';
import { buildManifest } from './manifest.config';

const root = import.meta.dirname;

/** Local development defaults. Production-like builds must provide explicit values (fail closed). */
const DEVELOPMENT_DEFAULTS = {
  VITE_API_BASE_URL: 'http://localhost:8787',
  VITE_ENV: 'local',
} as const;

function emitManifest(manifestJson: string): Plugin {
  return {
    name: 'heed-emit-manifest',
    generateBundle() {
      this.emitFile({ type: 'asset', fileName: 'manifest.json', source: manifestJson });
    },
  };
}

export default defineConfig(({ mode }) => {
  // Only VITE_-prefixed variables are read: server variables can never be pulled into the bundle.
  const env = loadEnv(mode, root, 'VITE_');
  const source: Record<string, string | undefined> = {};
  for (const name of PUBLIC_CONFIG_VARIABLE_NAMES) {
    source[name] = env[name] ?? (mode === 'development' ? DEVELOPMENT_DEFAULTS[name] : undefined);
  }
  // Throws (failing the build) if the public configuration is missing or unsafe.
  const publicConfig = parsePublicConfig(source);

  const pkg = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8')) as {
    version: string;
  };
  const manifestJson = `${JSON.stringify(buildManifest(publicConfig, pkg.version), null, 2)}\n`;

  return {
    root,
    base: './',
    publicDir: false,
    envPrefix: 'VITE_',
    define: {
      __HEED_VERSION__: JSON.stringify(pkg.version),
    },
    plugins: [react(), emitManifest(manifestJson)],
    build: {
      outDir: 'dist',
      emptyOutDir: true,
      sourcemap: false,
      minify: mode === 'development' ? false : 'oxc',
      target: 'chrome120',
      modulePreload: { polyfill: false },
      rolldownOptions: {
        input: {
          popup: resolve(root, 'popup.html'),
          sidepanel: resolve(root, 'sidepanel.html'),
          options: resolve(root, 'options.html'),
          'service-worker': resolve(root, 'src/background/service-worker.ts'),
        },
        output: {
          // The service worker must have a stable file name referenced by the manifest.
          entryFileNames: (chunk) =>
            chunk.name === 'service-worker' ? 'service-worker.js' : 'assets/[name]-[hash].js',
          chunkFileNames: 'assets/[name]-[hash].js',
          assetFileNames: 'assets/[name]-[hash][extname]',
        },
      },
    },
  };
});
