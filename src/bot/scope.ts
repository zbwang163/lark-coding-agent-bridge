import type { LarkChannel, NormalizedMessage } from '@larksuite/channel';
import type { ChatModeCache } from './chat-mode-cache';
import { resolveImConversation } from './im-conversation';

/**
 * Compute the **session scope** for a message.
 *
 *  - **p2p**: scope = `chatId`.
 *  - **ordinary group**: scope = `${chatId}:${rootMessageId}` — every root
 *    question and its generated topic own one session.
 *  - **topic group**: scope = `${chatId}:${threadId}` — each topic is an
 *    independent conversation with its own session / cwd / pending queue.
 *    Topic-group top-level messages (no threadId, rare) fall back to chatId.
 *
 * Async because chat mode requires an API lookup (cached after first hit).
 * Callers typically await this once at intake/cardAction entry and pass
 * the resolved scope through.
 */
export async function scopeForMessage(
  channel: LarkChannel,
  msg: NormalizedMessage,
  cache: ChatModeCache,
): Promise<string> {
  const mode = await cache.resolve(channel, msg.chatId);
  return resolveImConversation(msg, mode).scope;
}
