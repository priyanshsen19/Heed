import type { ConnectionState } from '../lib/connection';

export interface ConnectionPanelProps {
  readonly state: ConnectionState;
  readonly onRetry: () => void;
}

/**
 * The only content in Stage 1: a truthful connection state. No tasks, reminders, or integration data
 * exist yet, so none is shown (and none is faked).
 */
export function ConnectionPanel({ state, onRetry }: ConnectionPanelProps) {
  switch (state.kind) {
    case 'loading':
      return (
        <p role="status" className="muted">
          Loading…
        </p>
      );
    case 'not_connected':
      return (
        <section aria-labelledby="connection-heading" className="panel">
          <h2 id="connection-heading">Not connected</h2>
          <p>
            Heed is not connected to a Google account. Sign-in is not available in this build yet.
          </p>
          <p className="muted">
            When connected, Heed only reads. It never sends or changes anything in your Google
            account.
          </p>
        </section>
      );
    case 'signed_in':
      return (
        <section aria-labelledby="connection-heading" className="panel">
          <h2 id="connection-heading">Signed in</h2>
          <p>Nothing to show yet.</p>
        </section>
      );
    case 'error':
      return (
        <section role="alert" className="panel panel-error">
          <h2>Something went wrong</h2>
          <p>{state.message}</p>
          <button type="button" onClick={onRetry}>
            Try again
          </button>
        </section>
      );
  }
}
