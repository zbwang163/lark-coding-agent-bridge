# 提前显示过程卡片 Implementation Plan

> **For agentic workers:** 使用 superpowers:executing-plans 在当前会话实施。用户已确认提前创建卡片并补齐搜索等工具事件；仅更新独立测试服务，不新增、修改或运行单测。

**Goal:** 请求开始后及时显示同一张“正在思考”卡片，不再把搜索前的公开进度暂存到最终答案出现。

**Architecture:** `RunCardPublisher.begin()` 异步串行创建初始状态卡片，IM 调度无需等待模型输出。Codex JSONL 适配器识别搜索、MCP 等已知工具项目，在工具边界释放此前暂存的公开文字，同时发出工具摘要和完成状态；内部 reasoning 不进入卡片。最终答案仍单独判定，保留超长答案续发。

**Tech Stack:** TypeScript、现有 Codex CLI JSONL、CardKit 2.0。

**Spec:** `docs/superpowers/specs/2026-11-24-fold-thinking-design.md`

## Global Constraints

- 沿用 `codex/fold-thinking` 及现有独立 worktree；更新原 PR。
- 不改模型、Prompt、实际工具执行、Agent 权限或会话身份。
- 只展示公开进度和工具摘要，不输出内部推理或搜索/MCP 工具返回正文。
- 初始状态卡与后续过程、答案使用同一实体；超长答案仍分段续发。
- 不新增、修改或执行单测；允许真实只读 CLI 事件诊断、编译及测试服务部署。
- 生产服务及凭证保持不变；授权失败停止依赖该授权的操作。

## Review Focus

- 建卡未完成时收到终态：串行收尾、复用同一实体，不遗留定时器。
- 初始建卡失败或授权失败：不得重复发送过程卡或绕过权限。
- 搜索/MCP 仅有 completed 事件：补齐工具摘要和结果，不让进度继续积压。
- 未知项目、reasoning、usage：不能把候选最终答案误判为过程。
- 初始状态卡之后的空结果、仅最终答案及超长答案：原卡正常收尾，不新增占位卡。

### Task 1: 初始卡片和工具边界

**Files:** `src/bot/run-card.ts`、`src/bot/channel.ts`、`src/agent/codex/jsonl.ts`、README 中英文及设计文档。

**Interfaces:** 新增 `RunCardPublisher.begin(): Promise<void>`；保留 `update/finish`；扩展 JSONL 工具项目到既有 `AgentEvent.tool_use/tool_result`，不增加执行型事件。

- [x] 用独立真实只读 CLI 调用确认网页搜索输出项目结构，仅保留事件元数据。
- [x] 异步初始化同一张状态卡，收尾时再次清理异步建卡可能新增的定时器。
- [x] 按已知工具项目类型生成摘要，在工具边界释放暂存公开文字；保留未知项目及最终答案处理。
- [x] 静态独立审阅未发现明确的 Critical/Important；Vite、tsup（含 DTS）、`tsc --noEmit` 和 `git diff --check` 通过。提交推送随本次交付完成。

### Task 2: 独立测试部署

- [ ] 确认测试端无在途请求，保留旧构建，只替换私有测试 release/dist。
- [ ] 重启并确认 ws.connected / profile-online，核对构建哈希及生产 PID、启动时间、程序哈希不变。
- [ ] 更新原 PR，说明真实聊天首卡时延仍需新一轮请求验收。

## 执行记录

- 排查证据：21:15:29.326 已有公开进度；21:16:55.519 才进入卡片状态更新；21:16:56.635 发卡。期间实际执行网页搜索，转换器只识别命令工具，未释放暂存进度。
- Ruling: 用户明确不运行单测，跳过技能默认的 TDD；使用只读运行证据、静态审阅及授权的构建/部署检查，不声称单测或真实聊天验收已通过。
- 真实只读 CLI 诊断退出码 0、耗时 18.29 秒，确认 `item.started/completed` 中的工具类型为 `web_search`，公开进度项目为 `agent_message` 且没有 phase 字段。仅记录事件结构，未向飞书发送诊断消息，未改生产服务或凭证。
- 阅读既有命令异常事件断言，保留仅 completed 命令的原返回约定；新增工具的 completed-only 项目才补齐摘要。不修改或执行既有单测。
- Final review: 首卡、更新和收尾共享队列；初始授权失败在队列放行前锁定，收尾清除异步创建期间新增定时器。未知项目和 reasoning 不释放候选最终答案。MCP、动态工具及文件变更的真实失败格式未运行验证，实际飞书首卡时延也待新消息验收。
