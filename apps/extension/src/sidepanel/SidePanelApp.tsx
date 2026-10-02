import type { ConnectionSource } from '../lib/connection';
import { ConnectionPanel } from '../ui/ConnectionPanel';
import { Layout } from '../ui/Layout';
import { useConnectionState } from '../ui/useConnectionState';

export function SidePanelApp({ source }: { readonly source?: ConnectionSource }) {
  const { state, retry } = useConnectionState(source);
  return (
    <Layout title="Heed">
      <ConnectionPanel state={state} onRetry={retry} />
      {state.kind === 'signed_in' || state.kind === 'not_connected' ? (
        <section aria-labelledby="upcoming-heading" className="panel">
          <h2 id="upcoming-heading">Upcoming</h2>
          <p className="muted">Nothing to show yet.</p>
        </section>
      ) : null}
    </Layout>
  );
}
