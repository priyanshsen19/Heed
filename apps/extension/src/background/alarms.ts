/**
 * Alarm dispatch foundation. MV3 service workers are ephemeral, so recurring work must be driven by
 * `chrome.alarms` (never `setInterval`). Alarm names are `<handler>:<id>`; the dispatcher routes by the
 * part before the colon. Stage 1 registers no handlers and the `alarms` permission is not yet requested;
 * the sync heartbeat (Stage 11) and notification alarms (Stage 12) plug in here.
 */
export type AlarmHandler = (alarm: chrome.alarms.Alarm) => Promise<void>;

export function handlerKeyOf(alarmName: string): string {
  const index = alarmName.indexOf(':');
  return index === -1 ? alarmName : alarmName.slice(0, index);
}

export function createAlarmDispatcher(
  handlers: Readonly<Record<string, AlarmHandler>>,
  onError: (handlerKey: string) => void,
): (alarm: chrome.alarms.Alarm) => void {
  return (alarm) => {
    const key = handlerKeyOf(alarm.name);
    const handler = Object.hasOwn(handlers, key) ? handlers[key] : undefined;
    if (handler === undefined) {
      return;
    }
    handler(alarm).catch(() => {
      onError(key);
    });
  };
}
