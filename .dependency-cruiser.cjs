/**
 * Architectural boundaries (docs/ARCHITECTURE.md section 2). The CI job `check:boundaries` fails on any
 * `error` violation. The rules are exercised by scripts/boundaries.test.ts against throwaway fixtures.
 *
 * Allowed dependency directions:
 *
 *   apps/extension  -> packages/shared                        (and npm: react, react-dom)
 *   apps/api        -> packages/shared, packages/config, (later) packages/detection|ai
 *   packages/config -> packages/shared (optional)             (server-only, never reachable from the extension)
 *   packages/shared -> nothing internal                       (browser-safe leaf: zod only)
 *   scripts         -> packages/*                             (tooling only)
 *
 * Forbidden: extension -> anything server-side; server -> extension; shared -> anything internal.
 */
/** @type {import('dependency-cruiser').IConfiguration} */
module.exports = {
  forbidden: [
    {
      name: 'extension-may-import-only-shared',
      severity: 'error',
      comment:
        'The extension is a thin client. It may import only packages/shared among internal code; never API code, server configuration, database code, secrets, or provider code.',
      from: { path: '^apps/extension/' },
      to: { path: '^(apps/api|packages/(config|detection|ai|eval)|scripts)/' },
    },
    {
      name: 'extension-no-server-npm-modules',
      severity: 'error',
      comment:
        'Server, database, and provider libraries must never be bundled into the extension (no Google, Gemini, database, or Node server code).',
      from: { path: '^apps/extension/' },
      to: {
        dependencyTypes: [
          'npm',
          'npm-dev',
          'npm-optional',
          'npm-peer',
          'npm-bundled',
          'npm-no-pkg',
          'npm-unknown',
        ],
        path: '(^|/)node_modules/(fastify|fastify-[^/]+|@fastify|pino|pino-[^/]+|jose|@prisma|prisma|pg|@google|@google-cloud|googleapis|google-auth-library|undici)(/|$)',
      },
    },
    {
      name: 'extension-no-node-builtins',
      severity: 'error',
      comment: 'The extension runs in the browser; Node built-ins indicate server code leaking in.',
      from: { path: '^apps/extension/src/' },
      to: { dependencyTypes: ['core'] },
    },
    {
      name: 'server-must-not-import-extension',
      severity: 'error',
      comment: 'Server code and shared packages must never depend on the extension.',
      from: { path: '^(apps/api|packages)/' },
      to: { path: '^apps/extension/' },
    },
    {
      name: 'shared-is-a-leaf',
      severity: 'error',
      comment:
        'packages/shared holds browser-safe transport contracts and primitives only. It must not import any other internal package, any app, or Node built-ins.',
      from: { path: '^packages/shared/src/' },
      to: {
        path: '^(apps|scripts|packages/(config|detection|ai|eval))/',
      },
    },
    {
      name: 'shared-no-node-builtins',
      severity: 'error',
      comment: 'packages/shared must stay browser-safe.',
      from: { path: '^packages/shared/src/' },
      to: { dependencyTypes: ['core'] },
    },
    {
      name: 'packages-must-not-import-apps',
      severity: 'error',
      comment: 'Packages are libraries; applications depend on them, never the reverse.',
      from: { path: '^packages/' },
      to: { path: '^apps/' },
    },
    {
      name: 'no-circular',
      severity: 'error',
      comment: 'Circular dependencies are not allowed.',
      from: {},
      to: { circular: true },
    },
    {
      name: 'no-test-helpers-in-production',
      severity: 'error',
      comment: 'Production code must not import test doubles or test files.',
      from: {
        path: '^(apps|packages)/[^/]+/src/',
        pathNot: '\\.test\\.[tj]sx?$|/testing(\\.ts|/)',
      },
      to: { path: '(/testing(\\.ts|/)|\\.test\\.[tj]sx?$|/test/)' },
    },
  ],
  options: {
    doNotFollow: { path: 'node_modules' },
    exclude: { path: '(^|/)(dist|coverage)/|scripts/__fixtures__/' },
    tsPreCompilationDeps: true,
    tsConfig: { fileName: 'tsconfig.base.json' },
    enhancedResolveOptions: {
      exportsFields: ['exports'],
      conditionNames: ['import', 'require', 'node', 'default', 'types'],
      mainFields: ['module', 'main', 'types'],
    },
    reporterOptions: { text: { highlightFocused: true } },
  },
};
