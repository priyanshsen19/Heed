import { readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';

/**
 * Repository policy tests: the CI/CD, container, and infrastructure rules from docs/SECURITY.md are
 * enforced by code so they cannot regress silently.
 */
const root = resolve(import.meta.dirname, '..');
const read = (path: string): string => readFileSync(join(root, path), 'utf8');

type Yaml = Record<string, unknown>;
const workflowFiles = readdirSync(join(root, '.github/workflows')).filter((f) =>
  f.endsWith('.yml'),
);
const workflows = new Map<string, Yaml>(
  workflowFiles.map((f) => [f, parse(read(`.github/workflows/${f}`)) as Yaml]),
);

function allUses(workflow: Yaml): string[] {
  const jobs = (workflow['jobs'] ?? {}) as Record<string, { steps?: { uses?: string }[] }>;
  return Object.values(jobs).flatMap((job) =>
    (job.steps ?? []).flatMap((step) => (step.uses !== undefined ? [step.uses] : [])),
  );
}

describe('GitHub Actions policy', () => {
  it('has the workflows the foundation requires', () => {
    expect(workflowFiles).toEqual(expect.arrayContaining(['ci.yml', 'deploy-api-staging.yml']));
  });

  it.each(workflowFiles)('%s: every third-party action is pinned to a full commit SHA', (file) => {
    for (const uses of allUses(workflows.get(file) as Yaml)) {
      if (uses.startsWith('./')) {
        continue;
      }
      expect(uses, `${file}: ${uses}`).toMatch(/^[\w.-]+\/[\w./-]+@[0-9a-f]{40}$/);
    }
  });

  it.each(workflowFiles)('%s: declares least-privilege permissions and never write-all', (file) => {
    const workflow = workflows.get(file) as Yaml;
    const permissions = workflow['permissions'] as Record<string, string> | string | undefined;
    expect(permissions, `${file} must declare top-level permissions`).toBeDefined();
    expect(permissions).not.toBe('write-all');
    expect((permissions as Record<string, string>)['contents']).toBe('read');
  });

  it.each(workflowFiles)(
    '%s: never uses pull_request_target (fork PRs must not get a privileged context)',
    (file) => {
      expect(read(`.github/workflows/${file}`)).not.toContain('pull_request_target');
    },
  );

  it('ci.yml needs no secrets, cloud identity, or environment, and runs for pull requests', () => {
    const text = read('.github/workflows/ci.yml');
    const ci = workflows.get('ci.yml') as Yaml;
    expect(text).not.toMatch(/secrets\./);
    expect(text).not.toMatch(/id-token:\s*write/);
    expect(text).not.toMatch(/\benvironment:/);
    expect(Object.keys(ci['on'] as object)).toContain('pull_request');
    expect(text).toContain('persist-credentials: false');
  });

  it('ci.yml runs every required gate', () => {
    const text = read('.github/workflows/ci.yml');
    for (const gate of [
      'pnpm install --frozen-lockfile',
      'pnpm lint',
      'pnpm typecheck',
      'pnpm test',
      'pnpm test:boundaries',
      'pnpm build:extension',
      'pnpm scan:bundle',
      'pnpm build:api',
      'scripts/docker-smoke.sh',
    ]) {
      expect(text, gate).toContain(gate);
    }
  });

  it('the staging deploy is manual-only, uses Workload Identity Federation, and holds no key material', () => {
    const text = read('.github/workflows/deploy-api-staging.yml');
    const deploy = workflows.get('deploy-api-staging.yml') as Yaml;
    expect(Object.keys(deploy['on'] as object)).toEqual(['workflow_dispatch']);
    expect(text).toContain('workload_identity_provider');
    expect(text).not.toMatch(
      /credentials_json|service_account_key|GOOGLE_APPLICATION_CREDENTIALS/i,
    );
    expect(text).not.toMatch(/secrets\./);
    expect(text).toMatch(/environment:\s*staging/);
  });
});

describe('Dependabot and CODEOWNERS', () => {
  it('Dependabot covers npm, GitHub Actions, and Docker base images', () => {
    const config = parse(read('.github/dependabot.yml')) as {
      updates: { 'package-ecosystem': string }[];
    };
    expect(config.updates.map((u) => u['package-ecosystem']).sort()).toEqual([
      'docker',
      'github-actions',
      'npm',
    ]);
  });

  it('CODEOWNERS protects the manifest, build config, CI, infra, boundaries, scanner, and security docs', () => {
    const owners = read('.github/CODEOWNERS');
    for (const path of [
      '/apps/extension/manifest.config.ts',
      '/apps/extension/vite.config.ts',
      '/.github/',
      '/infra/',
      '/.dependency-cruiser.cjs',
      '/scripts/bundle-scan.ts',
      '/docs/SECURITY.md',
      '/docs/PRIVACY.md',
      '/packages/config/',
    ]) {
      expect(owners, path).toContain(path);
    }
  });
});

describe('container policy (infra/Dockerfile)', () => {
  const dockerfile = read('infra/Dockerfile');
  const instructions = dockerfile.split('\n').filter((line) => /^[A-Z]+\s/.test(line.trim()));

  it('pins base images by digest', () => {
    expect(dockerfile).toMatch(/ARG NODE_IMAGE=node:\d+\.\d+\.\d+-[\w-]+@sha256:[0-9a-f]{64}/);
    expect(dockerfile).toMatch(
      /ARG RUNTIME_IMAGE=gcr\.io\/distroless\/[\w.-]+:[\w-]+@sha256:[0-9a-f]{64}/,
    );
  });

  it('runs as a numeric non-root user in the final stage', () => {
    const lastFrom = dockerfile.lastIndexOf('\nFROM ');
    const finalStage = dockerfile.slice(lastFrom);
    expect(finalStage).toMatch(/^USER\s+(?!0\b)(?!root\b)\d+:\d+/m);
  });

  it('installs deterministically and bakes in no secrets', () => {
    expect(dockerfile).toContain('--frozen-lockfile');
    expect(dockerfile).not.toMatch(/ARG\s+\w*(SECRET|KEY|TOKEN|PASSWORD|PEPPER)\w*/i);
    expect(dockerfile).not.toMatch(/ENV\s+\w*(SECRET|KEY|TOKEN|PASSWORD|PEPPER|DATABASE_URL)\w*/i);
    expect(dockerfile).not.toMatch(/COPY[^\n]*\.env|COPY[^\n]*secrets/i);
    expect(instructions.some((line) => /^COPY\s+\.\s+\./.test(line))).toBe(false);
  });

  it('copies only the bundle into the runtime image', () => {
    const lastFrom = dockerfile.lastIndexOf('\nFROM ');
    const finalStage = dockerfile.slice(lastFrom);
    const copies = finalStage.split('\n').filter((l) => l.startsWith('COPY'));
    expect(copies).toHaveLength(1);
    expect(copies[0]).toContain('main.cjs');
  });

  it('.dockerignore and .gitignore keep secrets out', () => {
    const dockerignore = read('.dockerignore');
    const gitignore = read('.gitignore');
    for (const entry of ['**/.env', '.secrets.local.json']) {
      expect(dockerignore, entry).toContain(entry);
    }
    for (const entry of ['.env', '.secrets.local.json']) {
      expect(gitignore, entry).toContain(entry);
    }
  });
});

describe('Cloud Run policy (infra/cloudrun/service.staging.yaml)', () => {
  const text = read('infra/cloudrun/service.staging.yaml');
  const service = parse(text.replace(/\$\{\w+\}/g, 'x')) as {
    spec: {
      template: {
        metadata: { annotations: Record<string, string> };
        spec: {
          containers: {
            env: { name: string; value?: string; valueFrom?: unknown }[];
            resources: { limits: Record<string, string> };
          }[];
        };
      };
    };
  };
  const container = service.spec.template.spec.containers[0];

  it('scales to zero, never beyond two instances, with request-based CPU', () => {
    const annotations = service.spec.template.metadata.annotations;
    expect(annotations['autoscaling.knative.dev/minScale']).toBe('0');
    expect(annotations['autoscaling.knative.dev/maxScale']).toBe('2');
    expect(annotations['run.googleapis.com/cpu-throttling']).toBe('true');
    expect(container?.resources.limits).toEqual({ cpu: '1', memory: '512Mi' });
  });

  it('injects the runtime secret from Secret Manager and holds no secret literals', () => {
    const env = container?.env ?? [];
    const secretEntry = env.find((e) => e.name === 'HEED_RUNTIME_SECRETS_JSON');
    expect(secretEntry?.valueFrom).toBeDefined();
    expect(secretEntry?.value).toBeUndefined();
    for (const entry of env.filter(
      (e) =>
        /KEY|SECRET|TOKEN|PASSWORD|PEPPER|DATABASE_URL/i.test(e.name) &&
        e.name !== 'HEED_RUNTIME_SECRETS_JSON',
    )) {
      expect(entry.value, entry.name).toBeUndefined();
    }
  });

  it('is configured for staging with explicit CORS origins and health probes', () => {
    expect(text).toContain('value: staging');
    expect(text).toContain('CORS_ALLOWED_ORIGINS');
    expect(text).toContain('/readyz');
    expect(text).toContain('/healthz');
  });
});
