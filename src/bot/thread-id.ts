import type { LarkChannel } from '@larksuite/channel';
import { log } from '../core/logger';

/**
 * Recover a message's topic `thread_id` (omt_*) via the raw `im.v1.message.get`
 * API.
 *
 * Feishu delivers a sizable fraction of topic-group message events (and every
 * card-action carrier) without a `thread_id` on the event payload — notably the
 * message that starts a new topic. The bridge routes topic replies and isolates
 * per-topic session scope off `thread_id`, so a missing one makes the reply
 * escape into a brand-new topic and collapses the scope to the chat level.
 *
 * The raw `im.v1.message.get` items DO carry `thread_id` even when the event
 * dropped it. We deliberately avoid `channel.fetchMessage()`: its
 * NormalizedMessage path rebuilds a synthetic raw event without `thread_id`, so
 * threadId always comes back undefined.
 *
 * Returns an empty context on error. Callers fall back to chat-level routing
 * when the identifier required by their chat mode is absent.
 */
export interface MessageThreadContext {
  threadId?: string;
  rootId?: string;
}

export async function lookupMessageThreadContext(
  channel: LarkChannel,
  messageId: string,
): Promise<MessageThreadContext> {
  try {
    const [parent] = await channel.fetchRawMessage(messageId);
    // ApiMessageItem's SDK type omits these fields even though the API returns
    // them. Ordinary-group topics are scoped by root_id; native topic groups
    // continue to use thread_id.
    const raw = parent as { thread_id?: string; root_id?: string } | undefined;
    return { threadId: raw?.thread_id, rootId: raw?.root_id };
  } catch (err) {
    log.warn('thread', 'thread-id-lookup-failed', {
      messageId,
      err: err instanceof Error ? err.message : String(err),
    });
    return {};
  }
}

export async function lookupMessageThreadId(
  channel: LarkChannel,
  messageId: string,
): Promise<string | undefined> {
  return (await lookupMessageThreadContext(channel, messageId)).threadId;
}
