import type { LarkChannel } from '@larksuite/channel';
import { log } from '../core/logger';

export type ChatMode = 'p2p' | 'group' | 'topic';

/**
 * In-memory cache for `channel.getChatMode()` results.
 *
 * Why: chat mode (`p2p` / `group` / `topic`) doesn't change within a chat's
 * lifetime under normal use, and the SDK doesn't expose it on the message
 * event — so we cache by chatId to avoid an `im.v1.chat.get` round-trip per
 * message. A `threadId` is valid in both ordinary and topic groups, so the
 * channel layer re-probes a cached group once when its first threaded message
 * arrives. This detects a real group-to-topic conversion without invalidating
 * ordinary-group cache entries on every follow-up.
 *
 * On lookup failure (network / permission / unknown chatId) we **fall back
 * to 'group'** — that's the conservative default since it means "treat as
 * an ordinary group". Doesn't crash.
 */
export class ChatModeCache {
  private readonly cache = new Map<string, ChatMode>();

  async resolve(channel: LarkChannel, chatId: string): Promise<ChatMode> {
    const hit = this.cache.get(chatId);
    if (hit) return hit;
    try {
      const mode = await channel.getChatMode(chatId);
      this.cache.set(chatId, mode);
      log.info('chat', 'mode-resolved', { chatId, mode });
      return mode;
    } catch (err) {
      log.warn('chat', 'mode-resolve-failed', {
        chatId,
        err: err instanceof Error ? err.message : String(err),
      });
      // Don't poison the cache — next message gets another try.
      return 'group';
    }
  }

  invalidate(chatId: string): void {
    this.cache.delete(chatId);
  }
}
