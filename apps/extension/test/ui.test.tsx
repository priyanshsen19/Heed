import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FakeClock } from '@heed/shared/testing';
import type { ConnectionSource, ConnectionState } from '../src/lib/connection';
import { createChromeConnectionSource } from '../src/lib/connection';
import { OptionsApp } from '../src/options/OptionsApp';
import { PopupApp } from '../src/popup/PopupApp';
import { SidePanelApp } from '../src/sidepanel/SidePanelApp';
import { VALID_SESSION_TOKEN, installChromeMock, type ChromeMock } from './chrome-mock';

function source(
  read: () => Promise<ConnectionState>,
): ConnectionSource & { readonly reads: () => number } {
  let count = 0;
  return {
    read: () => {
      count += 1;
      return read();
    },
    subscribe: () => () => undefined,
    reads: () => count,
  };
}

let mock: ChromeMock;
beforeEach(() => {
  mock = installChromeMock();
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('empty production shells (no fake data)', () => {
  it('popup: shows loading, then the truthful "Not connected" state', async () => {
    render(<PopupApp source={source(() => Promise.resolve({ kind: 'not_connected' }))} />);
    expect(screen.getByRole('status').textContent).toContain('Loading');
    expect(await screen.findByRole('heading', { name: 'Not connected' })).toBeTruthy();
    expect(screen.queryByRole('status')).toBeNull();
  });

  it('popup: error state offers a retry that reads again', async () => {
    let attempt = 0;
    const src = source(() => {
      attempt += 1;
      return Promise.resolve(
        attempt === 1
          ? { kind: 'error', message: 'Heed could not read its local state.' }
          : { kind: 'not_connected' },
      );
    });
    render(<PopupApp source={src} />);
    expect((await screen.findByRole('alert')).textContent).toContain('could not read');
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByRole('heading', { name: 'Not connected' })).toBeTruthy();
    expect(src.reads()).toBe(2);
  });

  it('popup: signed-in state is an empty state, not invented content', async () => {
    render(<PopupApp source={source(() => Promise.resolve({ kind: 'signed_in' }))} />);
    expect(await screen.findByRole('heading', { name: 'Signed in' })).toBeTruthy();
    expect(screen.getByText('Nothing to show yet.')).toBeTruthy();
  });

  it('popup: buttons use real Chrome APIs (settings, side panel)', async () => {
    render(<PopupApp source={source(() => Promise.resolve({ kind: 'not_connected' }))} />);
    await screen.findByRole('heading', { name: 'Not connected' });
    fireEvent.click(screen.getByRole('button', { name: 'Settings' }));
    const runtime = mock.chrome['runtime'] as { openOptionsPage: ReturnType<typeof vi.fn> };
    expect(runtime.openOptionsPage).toHaveBeenCalledOnce();
    fireEvent.click(screen.getByRole('button', { name: 'Open side panel' }));
    const panel = mock.chrome['sidePanel'] as { open: ReturnType<typeof vi.fn> };
    await waitFor(() => {
      expect(panel.open).toHaveBeenCalledWith({ windowId: 7 });
    });
  });

  it('side panel: empty "Upcoming" with no tasks, reminders, or mock items', async () => {
    const { container } = render(
      <SidePanelApp source={source(() => Promise.resolve({ kind: 'not_connected' }))} />,
    );
    expect(await screen.findByRole('heading', { name: 'Upcoming' })).toBeTruthy();
    expect(container.textContent).not.toMatch(
      /interview|assignment|acme|due (today|tomorrow)|reminder at/i,
    );
  });

  it('side panel: no content section while loading or on error', async () => {
    render(
      <SidePanelApp source={source(() => Promise.resolve({ kind: 'error', message: 'x' }))} />,
    );
    await screen.findByRole('alert');
    expect(screen.queryByRole('heading', { name: 'Upcoming' })).toBeNull();
  });

  it('options: shows build information from validated public configuration', async () => {
    render(
      <OptionsApp
        source={source(() => Promise.resolve({ kind: 'not_connected' }))}
        config={{ ok: true, config: { apiOrigin: 'https://api.example.test', env: 'staging' } }}
        version="0.0.1"
      />,
    );
    expect(await screen.findByText('https://api.example.test')).toBeTruthy();
    expect(screen.getByText('staging')).toBeTruthy();
    expect(screen.getByText('0.0.1')).toBeTruthy();
  });

  it('options: surfaces a broken configuration instead of hiding it', async () => {
    render(
      <OptionsApp
        source={source(() => Promise.resolve({ kind: 'not_connected' }))}
        config={{ ok: false, error: 'bad config' }}
        version="0.0.1"
      />,
    );
    expect(
      (await screen.findAllByRole('alert')).some((el) => el.textContent.includes('bad config')),
    ).toBe(true);
  });
});

describe('connection source (reads chrome.storage.local only)', () => {
  const future = '2099-01-01T00:00:00.000Z';
  const stored = (idle: string, absolute: string) => ({
    sessionToken: VALID_SESSION_TOKEN,
    idleExpiresAt: idle,
    absoluteExpiresAt: absolute,
  });

  it('not connected without a credential', async () => {
    expect(await createChromeConnectionSource(new FakeClock()).read()).toEqual({
      kind: 'not_connected',
    });
  });

  it('signed in with an unexpired credential; not connected once idle or absolute expiry passes (injected clock)', async () => {
    mock.store.set('auth', stored('2026-06-01T00:00:00.000Z', future));
    const clock = new FakeClock('2026-05-01T00:00:00.000Z');
    const connection = createChromeConnectionSource(clock);
    expect(await connection.read()).toEqual({ kind: 'signed_in' });
    clock.set('2026-06-02T00:00:00.000Z');
    expect(await connection.read()).toEqual({ kind: 'not_connected' });
  });

  it('reports an error when storage fails', async () => {
    vi.unstubAllGlobals();
    installChromeMock({ failStorage: true });
    expect(await createChromeConnectionSource(new FakeClock()).read()).toMatchObject({
      kind: 'error',
    });
  });

  it('notifies subscribers only for local-area auth changes, and unsubscribes cleanly', () => {
    const connection = createChromeConnectionSource(new FakeClock());
    const onChange = vi.fn();
    const stop = connection.subscribe(onChange);
    mock.emitStorageChange({ auth: {} });
    mock.emitStorageChange({ other: {} });
    mock.emitStorageChange({ auth: {} }, 'sync');
    expect(onChange).toHaveBeenCalledTimes(1);
    stop();
    mock.emitStorageChange({ auth: {} });
    expect(onChange).toHaveBeenCalledTimes(1);
  });
});
