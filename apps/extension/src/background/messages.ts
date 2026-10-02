import { z } from 'zod';

/**
 * Typed runtime messaging between UI pages and the service worker (the single writer of local state).
 * Only messages from this extension are accepted and every payload is validated; there is no
 * `externally_connectable`, so web pages and other extensions cannot reach this handler.
 */
export const messageSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('status/get') }).strict(),
]);
export type ExtensionMessage = z.infer<typeof messageSchema>;

export interface MessageHandlerDeps {
  readonly extensionId: string;
  readonly getStatus: () => Promise<'signed_in' | 'not_connected'>;
}

export function createMessageHandler(deps: MessageHandlerDeps) {
  return (
    message: unknown,
    sender: { readonly id?: string | undefined },
    sendResponse: (response: unknown) => void,
  ): boolean => {
    if (sender.id !== deps.extensionId) {
      return false;
    }
    const parsed = messageSchema.safeParse(message);
    if (!parsed.success) {
      sendResponse({ ok: false, error: 'invalid_message' });
      return false;
    }
    deps
      .getStatus()
      .then((status) => {
        sendResponse({ ok: true, status });
      })
      .catch(() => {
        sendResponse({ ok: false, error: 'internal' });
      });
    return true; // asynchronous response
  };
}
