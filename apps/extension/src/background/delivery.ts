/**
 * Notification presentation contract (docs/ARCHITECTURE.md section 9). The SERVER composes the final text,
 * applies quiet hours and caps, and decides relevance; the extension only displays what it is given.
 * No implementation exists in Stage 1: `chrome.notifications` is not yet permitted by the manifest.
 */
export interface DisplayNotification {
  readonly id: string;
  readonly title: string;
  readonly body: string;
  readonly actions: readonly { readonly id: string; readonly label: string }[];
  /** An in-extension route, never an external URL. */
  readonly deepLink: string;
  readonly deliverAt: string;
}

export interface NotificationPresenter {
  show(notification: DisplayNotification): Promise<void>;
  clear(id: string): Promise<void>;
}
