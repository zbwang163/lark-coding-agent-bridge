# 超长答案分段发送 Implementation Plan

> **For agentic workers:** 使用 superpowers:executing-plans 在当前会话实施。用户已确认“正常答案单卡，超长答案分段续发，过程只保留一份”，并授权仅更新独立测试机器人；不新增、修改或运行单测。

**Goal:** 避免单卡容量限制导致最终答案无法展示，同时保留一份折叠过程。

**Architecture:** `RunCardPublisher` 在终态检查实际渲染卡片的 UTF-8 大小，超过 28000 字节时将完整 `finalText` 按序列化 Markdown 内容最多 8000 字节分段，再用原生 `post`/`md` 回复。已有过程卡片改为简短的后续消息提示；没有过程的轮次直接发送答案分段。每段 UUID 固定，始终保留原话题目标；仅明确的容量错误也可触发该路径，不因未知网络结果重复发送。

**Tech Stack:** TypeScript、既有 @larksuite/channel、CardKit 2.0。

**Spec:** `docs/superpowers/specs/2026-11-24-fold-thinking-design.md`

## Global Constraints

- 同主题沿用 `codex/fold-thinking` 和现有独立 worktree；提交推送并更新原 PR。
- 不新增依赖、配置项或 Agent 执行逻辑，不改变普通长度答案的单卡行为。
- 仅明确最终答案分段，过程文字及工具输出不重复进入答案。
- 沿用邮件脱敏、代码块分段、回复目标及话题参数。
- 授权失败停止后续操作；未知发送结果不自动重发完整答案。
- 不新增、修改或运行单测；允许构建并更新独立测试服务，生产保持不变。

## Review Focus

- 多字节中文、转义字符和脱敏扩张：按渲染后的整卡字节计量，非原始字符数。
- 有过程卡和仅最终答案：最多一份过程，最终答案不截断。
- 超限错误 200860/230025：仅明确容量拒绝触发分段，其他失败不盲目再发答案。
- 卡片提示更新失败：非授权错误不能挡住尚未发送的长答案；授权错误必须停止。
- 多次 finish 和分段中途失败：不重新发送已尝试发送的完整答案。

### Task 1: 终态容量判断与分段

**Files:** `src/bot/run-card.ts`、新增 `src/card/split-markdown.ts`、README 中英文、现有设计文档。分段工具独立负责字节预算和代码围栏，发布器只负责发送和收尾。

**Interfaces:** 保留 `RunCardPublisher.update(state)` / `finish(state)`；新增私有 `finalizeCard(state)` / `finalizeLongAnswer(state)` 和 `splitMarkdown(text, maxBytes): string[]`，复用现有 `renderCard`、`maskEmails` 和原生 SDK reply 接口。

- [x] 将最终答案发布集中到 finish，并复用同一个收尾 Promise。
- [x] 按渲染后的 JSON UTF-8 字节判断是否超过 28000；明确容量错误也转分段。
- [x] 长答案收起并保留原过程卡，原生接口分段发送完整答案，每段检查业务码及消息回执。
- [x] 更新文档并执行 `git diff --check`；独立静态审阅发现的问题已修正，Vite、tsup（含 DTS）和 `tsc --noEmit` 均通过；提交推送随本次交付完成。

### Task 2: 测试服务部署

**Files:** 测试服务私有 release/dist；部署记录保存在仓库外 artifacts。

- [x] 备份测试版构建，确认上一轮已结束，仅替换测试程序文件。
- [x] 重启并确认 ws.connected / profile-online；核对部署哈希及生产 PID、启动时间和程序哈希不变。
- [x] 更新原 PR；明确真实超长答案客户端验收尚待用户新消息验证。

## 执行记录

- Ruling: 依照用户明确规则跳过技能默认的单测和 TDD 步骤，仅执行静态审阅、授权的构建及部署状态核验；因此不声称已完成超长答案的运行验收。
- 用户已确认上述行为方案，继续现有主题实施，不重复请求设计或部署许可。
- Final review: 独立静态审阅发现 SDK 长单行不拆分、无 UUID 的未知结果重试、授权错误格式降级、回复目标撤回后改发群顶层、明确建卡容量失败后不能创建简短过程卡五项 Important；已在一次修正中改为独立字节分段工具、固定 UUID 的原生 `post`/`md` 回复，并仅清除未创建实体时明确的容量错误。不声称运行复现或单测验证。
- Ruling: 不复用高层 SDK 的分段发送，以避免上述发送边界问题；保留已有原生 SDK 客户端及邮件脱敏。标准围栏跨段补齐，极长围栏头只保留源字符；实际复杂 Markdown 的客户端效果仍需验收。
- 构建及静态类型检查退出码均为 0；未执行单测或模拟消息发送。修正后的代码完成逐行静态复核，不将构建成功表述为分段发送已运行验收。

- 测试构建部署 `3b06089`，已确认 ws.connected、profile-online、启动 error 事件为 0；安装 CLI SHA-256 与构建一致，生产 PID 3839918、启动时间及程序哈希未变化。部署证据保存在仓库外 `artifacts/lark-channel-bridge/test-deployment-3b06089.json`。
