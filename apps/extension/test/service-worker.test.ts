import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createAlarmDispatcher, handlerKeyOf } from '../src/background/alarms';
import { createMessageHandler } from '../src/background/messages';
import { VALID_SESSION_TOKEN, installChromeMock, type ChromeMock } from './chrome-mock';

const alarm = (name: string): chrome.alarms.Alarm => ({
  name,
  scheduledTime: 0,
  persistAcrossSessions: false,
});

let mock: ChromeMock;

async function bootWorker(
  options: Parameters<typeof installChromeMock>[0] = {},
): Promise<ChromeMock> {
  vi.resetModules();
  mock = installChromeMock(options);
  await import('../src/background/service-worker');
  return mock;
}

beforeEach(() => {
  vi.restoreAllMocks();
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe('service worker bootstrap (MV3 lifecycle)', () => {
  it('registers every listener synchronously during module evaluation', async () => {
    const m = await bootWorker();
    expect(m.listeners.onInstalled).toHaveLength(1);
    expect(m.listeners.onStartup).toHaveLength(1);
    expect(m.listeners.onMessage).toHaveLength(1);
  });

  it('never uses setInterval (the worker can be stopped at any time; alarms are the mechanism)', async () => {
    const spy = vi.spyOn(globalThis, 'setInterval');
    await bootWorker({ withAlarms: true });
    expect(spy).not.toHaveBeenCalled();
  });

  it('records the local state schema version on install and on startup, idempotently', async () => {
    const m = await bootWorker();
    (m.listeners.onInstalled[0] as unknown as () => void)();
    await vi.waitFor(() => {
      expect(m.store.get('schemaVersion')).toBe(1);
    });
    (m.listeners.onStartup[0] as unknown as () => void)();
    await vi.waitFor(() => {
      expect(m.store.get('schemaVersion')).toBe(1);
    });
  });

  it('keeps nothing in memory: status is derived from storage on every call', async () => {
    const m = await bootWorker();
    const onMessage = m.listeners.onMessage[0] as unknown as (
      msg: unknown,
      sender: { id: string },
      respond: (r: unknown) => void,
    ) => boolean;
    const ask = () =>
      new Promise<unknown>((resolve) => {
        onMessage({ type: 'status/get' }, { id: 'a'.repeat(32) }, resolve);
      });
    expect(await ask()).toEqual({ ok: true, status: 'not_connected' });
    m.store.set('auth', {
      sessionToken: VALID_SESSION_TOKEN,
      idleExpiresAt: '2030-01-01T00:00:00.000Z',
      absoluteExpiresAt: '2030-06-01T00:00:00.000Z',
    });
    expect(await ask()).toEqual({ ok: true, status: 'signed_in' });
  });

  it('registers the alarm dispatcher only when the alarms permission exists', async () => {
    expect((await bootWorker()).listeners.onAlarm).toHaveLength(0);
    expect((await bootWorker({ withAlarms: true })).listeners.onAlarm).toHaveLength(1);
  });
});

describe('message handler', () => {
  const deps = {
    extensionId: 'ext-id',
    getStatus: () => Promise.resolve('not_connected' as const),
  };

  it('ignores messages from any other sender (web pages, other extensions)', () => {
    const respond = vi.fn();
    const handled = createMessageHandler(deps)(
      { type: 'status/get' },
      { id: 'someone-else' },
      respond,
    );
    expect(handled).toBe(false);
    expect(respond).not.toHaveBeenCalled();
    expect(createMessageHandler(deps)({ type: 'status/get' }, {}, respond)).toBe(false);
  });

  it('rejects invalid or extra-field payloads', () => {
    for (const bad of [null, 'x', {}, { type: 'nope' }, { type: 'status/get', extra: 1 }]) {
      const respond = vi.fn();
      expect(createMessageHandler(deps)(bad, { id: 'ext-id' }, respond)).toBe(false);
      expect(respond).toHaveBeenCalledWith({ ok: false, error: 'invalid_message' });
    }
  });

  it('answers a valid message asynchronously', async () => {
    const respond = vi.fn();
    expect(createMessageHandler(deps)({ type: 'status/get' }, { id: 'ext-id' }, respond)).toBe(
      true,
    );
    await vi.waitFor(() => {
      expect(respond).toHaveBeenCalledWith({ ok: true, status: 'not_connected' });
    });
  });
});

describe('alarm dispatcher', () => {
  it('routes by the name prefix and ignores unknown alarms', () => {
    const calls: string[] = [];
    const dispatch = createAlarmDispatcher(
      {
        sync: (a) => {
          calls.push(a.name);
          return Promise.resolve();
        },
      },
      () => undefined,
    );
    dispatch(alarm('sync:heartbeat'));
    dispatch(alarm('unknown:1'));
    dispatch(alarm('constructor:x'));
    expect(calls).toEqual(['sync:heartbeat']);
    expect(handlerKeyOf('a:b:c')).toBe('a');
    expect(handlerKeyOf('plain')).toBe('plain');
  });

  it('contains handler failures', async () => {
    const onError = vi.fn();
    const dispatch = createAlarmDispatcher(
      { sync: () => Promise.reject(new Error('boom')) },
      onError,
    );
    dispatch(alarm('sync:x'));
    await vi.waitFor(() => {
      expect(onError).toHaveBeenCalledWith('sync');
    });
  });
});
