import type { LarkChannel } from '@larksuite/channel';
import { renderCard, type RunCardRenderOptions } from '../card/run-renderer';
import type { RunState } from '../card/run-state';
import { log } from '../core/logger';

const UPDATE_INTERVAL_MS = 750;
const STREAM_WINDOW_MS = 9 * 60_000;

interface RunCardPublisherOptions {
  channel: LarkChannel;
  chatId: string;
  scope: string;
  sendOpts: { replyTo: string; replyInThread?: boolean };
  renderOptions: RunCardRenderOptions;
}

/** Publish one Codex run to one CardKit entity; callers await updates in event order. */
export class RunCardPublisher {
  private cardId: string | undefined;
  private messageId: string | undefined;
  private sequence = 0;
  private lastUpdateAt = 0;
  private createdAt = 0;
  private streaming = false;
  private deliveryError: unknown;
  private blocked = false;
  private operations: Promise<void> = Promise.resolve();
  private streamTimer: NodeJS.Timeout | undefined;
  private updateTimer: NodeJS.Timeout | undefined;
  private latestState: RunState | undefined;
  private finishing = false;

  /** Retain the existing reply target and signed rendering options for this run. */
  constructor(private readonly options: RunCardPublisherOptions) {}

  /** Serialize event-driven publishing with the independent streaming deadline. */
  update(state: RunState): Promise<void> {
    this.latestState = state;
    return this.enqueue(this.publish.bind(this, state));
  }

  /** Cancel the deadline and serialize final delivery behind any in-flight update. */
  finish(state: RunState): Promise<void> {
    this.finishing = true;
    this.clearTimers();
    return this.enqueue(this.finalize.bind(this, state));
  }

  /** Publish meaningful running states at most once per interval; keep draining on API failures. */
  private async publish(state: RunState): Promise<void> {
    // Terminal content is flushed by finish(), independent of the throttle.
    // After a delivery error only finish may repair the existing entity.
    if (this.finishing || state.terminal !== 'running' || this.deliveryError) return;
    // Empty states must still clear an existing tool-only card when preferences
    // change. A final-only turn waits for finish() and sends a completed card.
    if (!this.cardId && (!hasCardContent(state) || state.finalText?.trim())) return;
    const remainingMs = UPDATE_INTERVAL_MS - (Date.now() - this.lastUpdateAt);
    if (remainingMs > 0) {
      // Flush the last throttled state even if the agent then goes silent in
      // a tool. Otherwise the latest tool/status could remain invisible.
      if (!this.updateTimer) {
        this.updateTimer = setTimeout(this.publishLatest.bind(this), remainingMs);
        this.updateTimer.unref();
      }
      return;
    }
    if (this.updateTimer) clearTimeout(this.updateTimer);
    this.updateTimer = undefined;
    try {
      if (!this.cardId) {
        await this.start(state);
      } else {
        // Native streaming expires after 10 minutes. Close early and continue
        // updating this same entity without reopening streaming mode.
        if (this.streaming && Date.now() - this.createdAt >= STREAM_WINDOW_MS) {
          await this.closeStreaming();
        }
        await this.replace(state);
      }
      this.lastUpdateAt = Date.now();
    } catch (error) {
      this.recordFailure(error);
    }
  }

  /** Flush the final state to the original message, or send a final-only card once. */
  private async finalize(state: RunState): Promise<void> {
    // A failed/uncertain send must never be followed by a second send. An
    // authorization failure also forbids trying another API to deliver it.
    if (this.blocked || (this.deliveryError && !this.cardId)) throw this.deliveryError;
    if (!this.cardId) {
      if (hasCardContent(state)) {
        try {
          await this.start(state);
        } catch (error) {
          this.recordFailure(error);
          throw error;
        }
      }
      return;
    }
    try {
      try {
        await this.closeStreaming();
      } catch (error) {
        this.recordFailure(error);
        if (this.blocked) throw error;
        // A timeout may have hidden a successful settings update. Repair the
        // same entity with a terminal full update, never send another message.
        this.streaming = false;
      }
      await this.replace(state);
      // Even without a send receipt, updating the known entity can complete a
      // message the server accepted before the connection failed. Do not resend.
      if (!this.messageId) throw this.deliveryError ?? new Error('CardKit send receipt unknown');
      log.info('outbound', 'run-card-finished', {
        scope: this.options.scope,
        messageId: this.messageId,
        terminal: state.terminal,
      });
    } catch (error) {
      this.recordFailure(error);
      throw error;
    }
  }

  /** Create a single entity and send its reference without cross-path send fallbacks. */
  private async start(state: RunState): Promise<void> {
    this.streaming = state.terminal === 'running';
    const response = await this.options.channel.rawClient.cardkit.v1.card.create({
      data: { type: 'card_json', data: JSON.stringify(this.render(state)) },
    });
    requireCardSuccess(response);
    this.cardId = response.data?.card_id;
    if (!this.cardId) throw new Error('CardKit create returned no card_id');
    this.createdAt = Date.now();
    if (this.streaming) {
      this.streamTimer = setTimeout(this.expireStreaming.bind(this), STREAM_WINDOW_MS);
      this.streamTimer.unref();
    }
    // channel.send retries sends without a UUID. Use the native reply API with
    // a fixed deduplication key so uncertain delivery cannot create duplicates.
    const sent = await this.options.channel.rawClient.im.v1.message.reply({
      path: { message_id: this.options.sendOpts.replyTo },
      data: {
        msg_type: 'interactive',
        content: JSON.stringify({ type: 'card', data: { card_id: this.cardId } }),
        reply_in_thread: this.options.sendOpts.replyInThread,
        uuid: `run_card_${this.cardId}`,
      },
    });
    requireCardSuccess(sent);
    this.messageId = sent.data?.message_id;
    if (!this.messageId?.trim()) throw new Error('CardKit send returned no message_id');
    log.info('outbound', 'run-card-sent', {
      scope: this.options.scope,
      chatId: this.options.chatId,
      messageId: this.messageId,
    });
  }

  /** Replace this entity with a strictly newer sequence and inspect the API business code. */
  private async replace(state: RunState): Promise<void> {
    const sequence = ++this.sequence;
    const response = await this.options.channel.rawClient.cardkit.v1.card.update({
      path: { card_id: this.cardId! },
      data: {
        card: { type: 'card_json', data: JSON.stringify(this.render(state)) },
        sequence,
        uuid: `run_${this.cardId}_${sequence}`,
      },
    });
    requireCardSuccess(response);
  }

  /** Explicitly end native streaming before final layout updates or the server's timeout. */
  private async closeStreaming(): Promise<void> {
    if (this.blocked || !this.streaming || !this.cardId) return;
    const sequence = ++this.sequence;
    const response = await this.options.channel.rawClient.cardkit.v1.card.settings({
      path: { card_id: this.cardId },
      data: {
        settings: JSON.stringify({ config: { streaming_mode: false } }),
        sequence,
        uuid: `run_${this.cardId}_${sequence}`,
      },
    });
    requireCardSuccess(response);
    this.streaming = false;
  }

  /** Close streaming even during a silent, long-running tool; use the same operation queue. */
  private expireStreaming(): void {
    this.streamTimer = undefined;
    void this.enqueue(this.closeStreaming.bind(this)).catch(this.recordFailure.bind(this));
  }

  /** Publish the latest projected state once a throttled burst has settled. */
  private publishLatest(): void {
    this.updateTimer = undefined;
    if (this.finishing || !this.latestState) return;
    void this.enqueue(this.publish.bind(this, this.latestState)).catch(this.recordFailure.bind(this));
  }

  /** Do not leave timers that can mutate a completed or authorization-blocked card. */
  private clearTimers(): void {
    if (this.streamTimer) clearTimeout(this.streamTimer);
    if (this.updateTimer) clearTimeout(this.updateTimer);
    this.streamTimer = undefined;
    this.updateTimer = undefined;
  }

  /** Preserve operation order after failures so finalization can repair the original card. */
  private enqueue(operation: () => Promise<void>): Promise<void> {
    const result = this.operations.then(operation);
    this.operations = result.catch(ignoreQueueFailure);
    return result;
  }

  /** Keep the server streaming state authoritative even when the agent is still running. */
  private render(state: RunState): object {
    return renderCard(state, {
      ...this.options.renderOptions,
      foldProgress: true,
      streamingMode: this.streaming && state.terminal === 'running',
    });
  }

  /** Latch delivery failures without logging request objects, tokens or credential-bearing headers. */
  private recordFailure(error: unknown): void {
    this.deliveryError = error;
    this.blocked = this.blocked || isAuthorizationFailure(error);
    // No timeout task may make a later API call after an authorization failure.
    if (this.blocked) this.clearTimers();
    log.warn('outbound', this.blocked ? 'run-card-authorization-required' : 'run-card-update-failed', {
      scope: this.options.scope,
      messageId: this.messageId,
      error: error instanceof Error ? error.message : 'CardKit request failed',
      ...(this.blocked ? { hint: '需要为当前机器人应用授权 cardkit:card:write 及消息发送权限；已停止该卡片后续操作。' } : {}),
    });
  }
}

/** A failed operation is reported by its caller; it must not poison the serialization queue. */
function ignoreQueueFailure(): void {}

/** Ignore status-only/empty turns while preserving terminal failures and reasoning-only cards. */
function hasCardContent(state: RunState): boolean {
  return Boolean(state.finalText?.trim() || state.reasoning.content.trim()
    || state.blocks.some((block) => block.kind === 'tool' || block.content.trim())
    || state.terminal === 'error' || state.terminal === 'interrupted'
    || state.terminal === 'idle_timeout');
}

/** The SDK can resolve HTTP 200 with a nonzero Feishu business error code. */
function requireCardSuccess(response: { code?: number; msg?: string }): void {
  if (response.code === 0) return;
  throw Object.assign(new Error(`CardKit API failed: code=${response.code ?? '?'} ${response.msg ?? ''}`), {
    code: response.code,
  });
}

/** Recognize SDK/HTTP and Feishu permission failures so finalization cannot bypass them. */
function isAuthorizationFailure(error: unknown): boolean {
  const failure = error as {
    code?: number | string;
    status?: number;
    data?: { code?: number };
    cause?: unknown;
    response?: { status?: number; data?: { code?: number } };
  } | undefined;
  const status = failure?.response?.status ?? failure?.status;
  const code = Number(failure?.response?.data?.code ?? failure?.data?.code ?? failure?.code);
  return status === 401 || status === 403
    || failure?.code === 'permission_denied'
    || failure?.code === 'unauthorized' || failure?.code === 'forbidden'
    || code === 99991400 || code === 99991401
    || code === 300311 || code === 230002
    || (code >= 99991600 && code < 99991800)
    || Boolean(failure?.cause && failure.cause !== error && isAuthorizationFailure(failure.cause));
}
