// Bundles the API (and the workspace packages it uses) into one self-contained CommonJS file.
// The production image then needs no node_modules and no source tree.
import { build } from 'esbuild';

await build({
  entryPoints: ['src/main.ts'],
  outfile: 'dist/main.cjs',
  bundle: true,
  platform: 'node',
  target: 'node24',
  format: 'cjs',
  sourcemap: true,
  legalComments: 'none',
  logLevel: 'info',
});
