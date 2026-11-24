import type { NormalizedMessage } from '@larksuite/channel';
import type { ChatMode } from './chat-mode-cache';

export interface ImConversationRoute {
  scope: string;
  mode: ChatMode;
  baseMode: ChatMode;
  replyInThread: boolean;
}

export function resolveImConversation(
  msg: NormalizedMessage,
  baseMode: ChatMode,
): ImConversationRoute {
  if (baseMode === 'p2p') {
    return {
      scope: msg.chatId,
      mode: 'p2p',
      baseMode,
      replyInThread: false,
    };
  }

  if (baseMode === 'topic') {
    return {
      scope: msg.threadId ? `${msg.chatId}:${msg.threadId}` : msg.chatId,
      mode: 'topic',
      baseMode,
      replyInThread: Boolean(msg.threadId),
    };
  }

  // A flat reply carries the quoted message as rootId, but our threaded reply
  // promotes the current question into a new topic. Key the initial turn by
  // that prospective topic root so later topic replies resolve the same scope.
  const rootMessageId = msg.threadId
    ? (msg.rootId || msg.messageId)
    : msg.messageId;
  return {
    scope: `${msg.chatId}:${rootMessageId}`,
    mode: msg.threadId ? 'topic' : 'group',
    baseMode,
    replyInThread: true,
  };
}
