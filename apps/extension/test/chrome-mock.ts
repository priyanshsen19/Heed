import { vi } from 'vitest';

type Listener = (...args: never[]) => unknown;

export interface ChromeMock {
  readonly store: Map<string, unknown>;
  readonly listeners: {
    onInstalled: Listener[];
    onStartup: Listener[];
    onMessage: Listener[];
    onAlarm: Listener[];
    onStorageChanged: Listener[];
  };
  readonly chrome: Record<string, unknown>;
  emitStorageChange(changes: Record<string, unknown>, area?: string): void;
}

/** Minimal in-memory stand-in for the chrome.* APIs the extension uses. */
export function installChromeMock(
  options: { extensionId?: string; withAlarms?: boolean; failStorage?: boolean } = {},
): ChromeMock {
  const store = new Map<string, unknown>();
  const listeners: ChromeMock['listeners'] = {
    onInstalled: [],
    onStartup: [],
    onMessage: [],
    onAlarm: [],
    onStorageChanged: [],
  };
  const guard = (): void => {
    if (options.failStorage === true) {
      throw new Error('storage unavailable');
    }
  };
  const event = (list: Listener[]) => ({
    addListener: (fn: Listener) => {
      list.push(fn);
    },
    removeListener: (fn: Listener) => {
      const index = list.indexOf(fn);
      if (index >= 0) {
        list.splice(index, 1);
      }
    },
  });

  const chromeMock: Record<string, unknown> = {
    runtime: {
      id: options.extensionId ?? 'a'.repeat(32),
      onInstalled: event(listeners.onInstalled),
      onStartup: event(listeners.onStartup),
      onMessage: event(listeners.onMessage),
      openOptionsPage: vi.fn(() => Promise.resolve()),
    },
    storage: {
      local: {
        get: vi.fn((key: string) => {
          guard();
          return Promise.resolve(store.has(key) ? { [key]: store.get(key) } : {});
        }),
        set: vi.fn((items: Record<string, unknown>) => {
          guard();
          for (const [key, value] of Object.entries(items)) {
            store.set(key, value);
          }
          return Promise.resolve();
        }),
        remove: vi.fn((key: string) => {
          store.delete(key);
          return Promise.resolve();
        }),
        clear: vi.fn(() => {
          store.clear();
          return Promise.resolve();
        }),
      },
      onChanged: event(listeners.onStorageChanged),
    },
    sidePanel: { open: vi.fn(() => Promise.resolve()) },
    windows: { getCurrent: vi.fn(() => Promise.resolve({ id: 7 })) },
  };
  if (options.withAlarms === true) {
    chromeMock['alarms'] = { onAlarm: event(listeners.onAlarm) };
  }
  vi.stubGlobal('chrome', chromeMock);

  return {
    store,
    listeners,
    chrome: chromeMock,
    emitStorageChange(changes, area = 'local') {
      for (const listener of listeners.onStorageChanged) {
        (listener as unknown as (c: Record<string, unknown>, a: string) => void)(changes, area);
      }
    },
  };
}

export const VALID_SESSION_TOKEN = 'A'.repeat(43);
