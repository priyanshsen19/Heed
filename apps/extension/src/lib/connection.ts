import { SystemClock, type Clock } from '@heed/shared';
import { readItem } from '../background/storage';

export type ConnectionState =
  | { readonly kind: 'loading' }
  | { readonly kind: 'not_connected' }
  | { readonly kind: 'signed_in' }
  | { readonly kind: 'error'; readonly message: string };

export interface ConnectionSource {
  read(): Promise<ConnectionState>;
  /** Subscribes to changes; returns an unsubscribe function. */
  subscribe(onChange: () => void): () => void;
}

export function createChromeConnectionSource(clock: Clock = new SystemClock()): ConnectionSource {
  return {
    async read() {
      try {
        const auth = await readItem('auth');
        if (auth === undefined) {
          return { kind: 'not_connected' };
        }
        const expired =
          Date.parse(auth.absoluteExpiresAt) <= clock.nowMs() ||
          Date.parse(auth.idleExpiresAt) <= clock.nowMs();
        return expired ? { kind: 'not_connected' } : { kind: 'signed_in' };
      } catch {
        return { kind: 'error', message: 'Heed could not read its local state.' };
      }
    },
    subscribe(onChange) {
      const listener = (
        changes: Record<string, chrome.storage.StorageChange>,
        area: string,
      ): void => {
        if (area === 'local' && 'auth' in changes) {
          onChange();
        }
      };
      chrome.storage.onChanged.addListener(listener);
      return () => {
        chrome.storage.onChanged.removeListener(listener);
      };
    },
  };
}
