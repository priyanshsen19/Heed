/**
 * MV3 service worker. It is ephemeral (the browser stops it after about 30 seconds idle), so:
 *  - every listener is registered synchronously at top level, before any await;
 *  - nothing is kept in memory between events; durable state is chrome.storage.local;
 *  - recurring work uses chrome.alarms, never setInterval.
 * Stage 1 contains only the lifecycle foundation; sync, outbox, and notifications arrive later.
 */
import { createAlarmDispatcher } from './alarms';
import { ensureSchemaVersion } from './lifecycle';
import { createMessageHandler } from './messages';
import { readItem } from './storage';

chrome.runtime.onInstalled.addListener(() => {
  void ensureSchemaVersion();
});

chrome.runtime.onStartup.addListener(() => {
  void ensureSchemaVersion();
});

chrome.runtime.onMessage.addListener(
  createMessageHandler({
    extensionId: chrome.runtime.id,
    getStatus: async () => ((await readItem('auth')) === undefined ? 'not_connected' : 'signed_in'),
  }),
);

// The `alarms` permission is requested in a later stage; until then the API is absent.
if (typeof chrome.alarms !== 'undefined') {
  chrome.alarms.onAlarm.addListener(
    createAlarmDispatcher({}, () => {
      // Handler failures are surfaced by the handlers themselves; nothing to do here yet.
    }),
  );
}
