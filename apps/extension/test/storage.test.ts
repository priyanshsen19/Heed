import { beforeEach, describe, expect, it } from 'vitest';
import {
  CURRENT_SCHEMA_VERSION,
  clearLocalState,
  readItem,
  removeItem,
  writeItem,
} from '../src/background/storage';
import { VALID_SESSION_TOKEN, installChromeMock, type ChromeMock } from './chrome-mock';

let mock: ChromeMock;
beforeEach(() => {
  mock = installChromeMock();
});

const validAuth = {
  sessionToken: VALID_SESSION_TOKEN,
  idleExpiresAt: '2026-11-01T00:00:00.000Z',
  absoluteExpiresAt: '2027-01-01T00:00:00.000Z',
};

describe('local storage guard', () => {
  it('round-trips a valid Heed session credential', async () => {
    await writeItem('auth', validAuth);
    expect(await readItem('auth')).toEqual(validAuth);
  });

  // Secret-shaped values are assembled from fragments so no realistic secret is committed.
  it.each([
    ['Google access token', 'ya' + '29.a0AbCdEfGhIjKlMnOpQrStUvWxYz0123456789'],
    ['Google refresh token', '1/' + '/0gAbCdEfGhIjKlMnOpQrStUvWxYz0123456789abcdef'],
    ['Google API key', 'AI' + 'zaSyA-1234567890abcdefghijklmnopqrstuv'],
    ['Google client secret', 'GOC' + 'SPX-abcdefghijklmnopqrstuvwxyz12'],
    ['too short', 'abc'],
    ['too long', 'A'.repeat(300)],
  ])('refuses to store a %s as the session token', async (_label, token) => {
    await expect(writeItem('auth', { ...validAuth, sessionToken: token })).rejects.toThrow();
    expect(mock.store.has('auth')).toBe(false);
  });

  it('refuses credential fields the schema does not allow (strict objects)', async () => {
    const withGoogleToken = {
      ...validAuth,
      googleAccessToken: 'x',
      refreshToken: 'y',
    } as unknown as typeof validAuth;
    await expect(writeItem('auth', withGoogleToken)).rejects.toThrow();
  });

  it('refuses unknown keys at runtime, even if a JS caller bypasses the types', async () => {
    const write = writeItem as unknown as (key: string, value: unknown) => Promise<void>;
    await expect(write('googleRefreshToken', 'x')).rejects.toThrow(/unknown storage key/);
    await expect(write('__proto__', {})).rejects.toThrow(/unknown storage key/);
    await expect(write('constructor', {})).rejects.toThrow(/unknown storage key/);
    expect(mock.store.size).toBe(0);
  });

  it('discards corrupt or foreign stored values instead of trusting them', async () => {
    mock.store.set('auth', { sessionToken: 'ya' + '29.not-ours', extra: true });
    expect(await readItem('auth')).toBeUndefined();
    expect(mock.store.has('auth')).toBe(false);
  });

  it('removes keys and clears all local state (sign-out, delete my data)', async () => {
    await writeItem('auth', validAuth);
    await writeItem('schemaVersion', CURRENT_SCHEMA_VERSION);
    await removeItem('auth');
    expect(await readItem('auth')).toBeUndefined();
    await clearLocalState();
    expect(mock.store.size).toBe(0);
  });

  it('validates ui preferences strictly', async () => {
    await writeItem('ui.prefs', { lastTab: 'review' });
    expect(await readItem('ui.prefs')).toEqual({ lastTab: 'review' });
    await expect(writeItem('ui.prefs', { lastTab: 'nope' } as never)).rejects.toThrow();
  });
});
