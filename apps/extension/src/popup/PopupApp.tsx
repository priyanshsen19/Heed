import type { ConnectionSource } from '../lib/connection';
import { ConnectionPanel } from '../ui/ConnectionPanel';
import { Layout } from '../ui/Layout';
import { useConnectionState } from '../ui/useConnectionState';

export function PopupApp({ source }: { readonly source?: ConnectionSource }) {
  const { state, retry } = useConnectionState(source);

  const openSettings = (): void => {
    void chrome.runtime.openOptionsPage();
  };
  const openSidePanel = (): void => {
    void chrome.windows.getCurrent().then((window) => {
      if (window.id !== undefined) {
        void chrome.sidePanel.open({ windowId: window.id });
      }
    });
  };

  return (
    <Layout title="Heed">
      <ConnectionPanel state={state} onRetry={retry} />
      <nav className="actions" aria-label="Heed">
        <button type="button" onClick={openSidePanel}>
          Open side panel
        </button>
        <button type="button" onClick={openSettings}>
          Settings
        </button>
      </nav>
    </Layout>
  );
}
