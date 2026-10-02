import type { ConnectionSource } from '../lib/connection';
import { loadPublicConfig, type ConfigResult } from '../lib/config';
import { ConnectionPanel } from '../ui/ConnectionPanel';
import { Layout } from '../ui/Layout';
import { useConnectionState } from '../ui/useConnectionState';

export interface OptionsAppProps {
  readonly source?: ConnectionSource;
  readonly config?: ConfigResult;
  readonly version?: string;
}

export function OptionsApp({ source, config, version = __HEED_VERSION__ }: OptionsAppProps) {
  const { state, retry } = useConnectionState(source);
  const resolved = config ?? loadPublicConfig();

  return (
    <Layout title="Heed settings">
      <ConnectionPanel state={state} onRetry={retry} />
      <section aria-labelledby="about-heading" className="panel">
        <h2 id="about-heading">About this build</h2>
        {resolved.ok ? (
          <dl>
            <dt>Version</dt>
            <dd>{version}</dd>
            <dt>Environment</dt>
            <dd>{resolved.config.env}</dd>
            <dt>Service</dt>
            <dd>{resolved.config.apiOrigin}</dd>
          </dl>
        ) : (
          <p role="alert">This build has an invalid configuration: {resolved.error}</p>
        )}
      </section>
    </Layout>
  );
}
