import { deepMaskEmails } from './mask-email';
import type { Block, FooterStatus, RunState, ToolEntry } from './run-state';
import { toolBodyMd, toolHeaderText } from './tool-render';

const REASONING_MAX = 1500;
const COLLAPSE_TOOL_THRESHOLD = 3;
const PROCESS_MAX_BYTES = 8000;

interface ToolGroup {
  kind: 'tools';
  tools: ToolEntry[];
}
interface TextGroup {
  kind: 'text';
  content: string;
}
type Group = ToolGroup | TextGroup;

export interface RunCardRenderOptions {
  signCallback?: (action: string) => string;
  /** Codex keeps commentary in blocks and its answer in finalText. */
  foldProgress?: boolean;
  /** Long runs keep updating the entity after native streaming is closed. */
  streamingMode?: boolean;
}

/** Render a run card, optionally folding Codex commentary around its final answer. */
export function renderCard(state: RunState, options: RunCardRenderOptions = {}): object {
  const elements: object[] = options.foldProgress ? foldedRunElements(state) : [];

  if (!options.foldProgress && state.reasoning.content) {
    elements.push(reasoningPanel(state.reasoning.content, state.reasoning.active));
  }

  for (const group of groupBlocks(options.foldProgress ? [] : state.blocks)) {
    if (group.kind === 'text') {
      if (group.content.trim()) {
        elements.push(markdown(group.content));
      }
    } else {
      elements.push(...renderToolGroup(group.tools, state.terminal !== 'running'));
    }
  }

  if (state.terminal === 'interrupted') {
    elements.push(noteMd('_⏹ 已被中断_'));
  } else if (state.terminal === 'idle_timeout') {
    const mins = state.idleTimeoutMinutes ?? 0;
    elements.push(noteMd(`_⏱ ${mins} 分钟无响应,已自动终止_`));
  } else if (state.terminal === 'error' && state.errorMsg) {
    elements.push(noteMd(`⚠️ agent 失败：${state.errorMsg}`));
  } else if (state.terminal === 'done' && elements.length === 0) {
    elements.push(noteMd('_（未返回内容）_'));
  }

  if (state.terminal === 'running') {
    if (state.footer) elements.push(footerStatus(state.footer));
    // Folded Codex cards show progress without an action button.
    if (!options.foldProgress) elements.push(stopButton(options));
  }

  // Mask raw emails across every text field so the Feishu tenant audit doesn't
  // reject the (streamed) card with a 400 EMAIL_ADDRESS — see mask-email.ts.
  return deepMaskEmails({
    schema: '2.0',
    config: {
      streaming_mode: options.streamingMode ?? (state.terminal === 'running'),
      ...(options.foldProgress ? { update_multi: true } : {}),
      summary: { content: summaryText(state) },
    },
    body: { elements },
  });
}

/** Fold commentary and tool summaries without tool bodies; only explicit final text is an answer. */
function foldedRunElements(state: RunState): object[] {
  // A turn can finish without an answer after emitting commentary and tools.
  // Promoting those blocks would unfold the process and bypass its size cap.
  const answer = state.finalText ?? '';
  // Show live progress until an explicit answer arrives; terminal cards start
  // collapsed so completed work does not obscure the answer or failure notice.
  const processExpanded = state.terminal === 'running' && !answer.trim();
  const process: string[] = [];
  if (state.reasoning.content.trim()) process.push(state.reasoning.content.trim());
  for (const group of groupBlocks(state.blocks)) {
    if (group.kind === 'tools') {
      // Match brief COT: keep the invocation and status, never raw tool output
      // or detailed inputs. Consecutive calls share a compact list so each
      // tool does not introduce another empty paragraph.
      process.push(group.tools.map((tool) => `- ${toolHeaderText(tool)}`).join('\n'));
    } else if (group.content.trim()) {
      // Agent messages may already end in newlines; only the join below adds
      // paragraph spacing, preserving Markdown within each message.
      process.push(group.content.trim());
    }
  }
  const elements: object[] = [];
  if (process.length > 0) {
    // Reserve room for JSON framing and the answer within the card's 30KB cap.
    // Only process details are shortened; the actual answer is never truncated.
    const budget = Math.max(0, Math.min(PROCESS_MAX_BYTES,
      24000 - Buffer.byteLength(JSON.stringify(answer), 'utf8')));
    elements.push({
      tag: 'collapsible_panel',
      element_id: 'run_process',
      expanded: processExpanded,
      header: panelHeader(state.terminal === 'running'
        ? `🧠 **执行过程（点击${processExpanded ? '收起' : '展开'}）**`
        : '🧠 **执行过程（已结束，点击展开）**'),
      border: { color: 'grey', corner_radius: '5px' },
      padding: '8px',
      elements: [{
        tag: 'markdown',
        element_id: 'run_process_text',
        content: truncateProcess(process.join('\n\n'), budget),
        text_size: 'notation',
      }],
    });
  }
  if (answer.trim()) {
    elements.push({ tag: 'markdown', element_id: 'run_answer', content: answer });
  } else if (state.terminal === 'done') {
    elements.push(noteMd('_（未返回答案）_'));
  }
  return elements;
}

/** Bound serialized process text by UTF-8 bytes without cutting a Unicode character. */
function truncateProcess(content: string, maxBytes: number): string {
  if (Buffer.byteLength(JSON.stringify(content), 'utf8') <= maxBytes) return content;
  const suffix = '\n\n_（过程已截断，完整内容请查看本地会话记录）_';
  let budget = maxBytes - Buffer.byteLength(JSON.stringify(suffix), 'utf8');
  const chars: string[] = [];
  for (const char of content) {
    budget -= Buffer.byteLength(JSON.stringify(char), 'utf8') - 2;
    if (budget < 0) break;
    chars.push(char);
  }
  return chars.join('') + suffix;
}

function* groupBlocks(blocks: Block[]): Generator<Group> {
  let toolBuf: ToolEntry[] = [];
  for (const b of blocks) {
    if (b.kind === 'tool') {
      toolBuf.push(b.tool);
    } else {
      if (toolBuf.length > 0) {
        yield { kind: 'tools', tools: toolBuf };
        toolBuf = [];
      }
      yield { kind: 'text', content: b.content };
    }
  }
  if (toolBuf.length > 0) yield { kind: 'tools', tools: toolBuf };
}

function renderToolGroup(tools: ToolEntry[], finalized: boolean): object[] {
  if (tools.length === 0) return [];
  if (tools.length < COLLAPSE_TOOL_THRESHOLD) {
    return tools.map((t) => toolPanel(t, false));
  }
  if (finalized) {
    return [collapsedToolSummary(tools, true)];
  }
  // Running: collapse prior tools, keep latest visible.
  const prior = tools.slice(0, -1);
  const latest = tools[tools.length - 1];
  const out: object[] = [];
  if (prior.length > 0) out.push(collapsedToolSummary(prior, false));
  if (latest) out.push(toolPanel(latest, true));
  return out;
}

function reasoningPanel(content: string, active: boolean): object {
  const title = active ? '🧠 **思考中**' : '🧠 **思考完成，点击查看**';
  return collapsiblePanel({
    title,
    expanded: active,
    border: 'grey',
    body: truncate(content, REASONING_MAX),
  });
}

function toolPanel(tool: ToolEntry, expanded: boolean): object {
  return collapsiblePanel({
    title: toolHeaderText(tool),
    expanded,
    border: tool.status === 'error' ? 'red' : 'grey',
    body: toolBodyMd(tool) || '_无输出_',
  });
}

/**
 * Render N tool calls as a single collapsed panel. **Body content is dropped**
 * — only the per-tool header line (icon + name + short summary) is kept.
 *
 * Why no bodies: with full input/output panels nested, the serialized JSON
 * can easily exceed Feishu's per-element size limit (~30KB), causing 400
 * errors that abort the entire card stream. Tool details are still in the
 * file log; users who really need them can `/doctor` to inspect.
 *
 * The latest-running tool, when applicable, is rendered separately via
 * `toolPanel(latest, true)` so live observation isn't sacrificed.
 */
function collapsedToolSummary(tools: ToolEntry[], finalized: boolean): object {
  const suffix = finalized ? '（已结束）' : '';
  const title = `☕ **${tools.length} 个工具调用${suffix}**`;
  const headerList = tools.map((t) => `- ${toolHeaderText(t)}`).join('\n');
  return {
    tag: 'collapsible_panel',
    expanded: false,
    header: panelHeader(title),
    border: { color: 'blue', corner_radius: '5px' },
    vertical_spacing: '8px',
    padding: '8px 8px 8px 8px',
    elements: [{ tag: 'markdown', content: headerList, text_size: 'notation' }],
  };
}

interface PanelOpts {
  title: string;
  expanded: boolean;
  border: 'grey' | 'red' | 'blue';
  body: string;
}

function collapsiblePanel(opts: PanelOpts): object {
  return {
    tag: 'collapsible_panel',
    expanded: opts.expanded,
    header: panelHeader(opts.title),
    border: { color: opts.border, corner_radius: '5px' },
    vertical_spacing: '8px',
    padding: '8px 8px 8px 8px',
    elements: [{ tag: 'markdown', content: opts.body, text_size: 'notation' }],
  };
}

function panelHeader(titleMd: string): object {
  return {
    title: { tag: 'markdown', content: titleMd },
    vertical_align: 'center',
    icon: { tag: 'standard_icon', token: 'down-small-ccm_outlined', size: '16px 16px' },
    icon_position: 'follow_text',
    icon_expanded_angle: -180,
  };
}

function markdown(content: string): object {
  return { tag: 'markdown', content };
}

function noteMd(content: string): object {
  return { tag: 'markdown', content, text_size: 'notation' };
}

function stopButton(options: RunCardRenderOptions): object {
  const value: Record<string, unknown> = { cmd: 'stop' };
  if (options.signCallback) {
    value.__bridge_cb = true;
    value.bridge_token = options.signCallback('stop');
  }
  return {
    tag: 'button',
    text: { tag: 'plain_text', content: '⏹ 终止' },
    type: 'danger',
    behaviors: [{ type: 'callback', value }],
  };
}

function footerStatus(status: Exclude<FooterStatus, null>): object {
  const text =
    status === 'thinking'
      ? '🧠 正在思考'
      : status === 'tool_running'
        ? '🧰 正在调用工具'
        : '✍️ 正在输出';
  return noteMd(text);
}

function summaryText(state: RunState): string {
  if (state.terminal === 'interrupted') return '已中断';
  if (state.terminal === 'idle_timeout') return '已超时';
  if (state.terminal === 'error') return '出错';
  if (state.terminal === 'done') return '已完成';
  if (state.footer === 'tool_running') return '正在调用工具';
  if (state.footer === 'streaming') return '正在输出';
  return '思考中';
}

function truncate(s: string, max: number): string {
  return s.length > max ? `${s.slice(0, max)}…` : s;
}
