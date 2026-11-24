# Codex 单卡片回复 Implementation Plan

> **For agentic workers:** 使用 superpowers:executing-plans 在当前会话逐项实现；用户已确认执行，不再次请求实施许可。用户规则优先：不新增或修改单测，不编译，不执行单测，不部署。

**Goal:** 将 Codex 的过程和答案合并为一张卡片，过程默认收起。

**Architecture:** 在既有渲染器增加 Codex 过程折叠选项；独立发布器负责 CardKit 实体生命周期、节流和收尾。IM 调度将 Codex 的非纯文本模式交给发布器。

**Tech Stack:** TypeScript、现有 @larksuite/channel、飞书 CardKit JSON 2.0。

**Spec:** `docs/superpowers/specs/2026-11-24-fold-thinking-design.md`

## Global Constraints

- 不新增依赖或配置项；不改构建产物、运行服务和单测。
- 不执行编译、类型检查、单测或真实消息发送。
- 首次实施时 GitHub 授权失败，停止远端操作；使用本地备份作为基线。后续用户重新授权后，在其个人 fork 交付。

## Review Focus

- 仅最终答案、空结果：至多一条消息，不遗留占位卡片。
- 失败、中断、超时：保留可用文本与终止状态，不另发答案。
- 网络错误与授权错误：不重复发送，授权失败后停止 API 调用。
- 长任务和大量工具输出：关闭过期流式模式，过程限长，答案保留。
- 话题回复、停止按钮和工具显示偏好：沿用原有参数和签名。

### Task 1: 渲染单卡片

**Files:** `src/card/run-renderer.ts`

**Interfaces:** `RunCardRenderOptions` 增加 `foldProgress?: boolean`、`streamingMode?: boolean`；`renderCard(state, options)` 保持原返回类型。

- [x] 折叠过程与工具详情，单独展示 finalText；异常结束没有 finalText 时将已有文本保留在折叠过程内，终止提示放在面板外。
- [x] 保持既有 Claude 渲染路径；检查脱敏、过程长度和按钮签名（静态审阅）。

### Task 2: CardKit 发布与调度

**Files:** 新增 `src/bot/run-card.ts`；修改 `src/bot/channel.ts`。

**Interfaces:** `RunCardPublisher.update(state: RunState): Promise<void>`、`finish(state: RunState): Promise<void>`，只更新该轮唯一卡片。

- [x] 串行创建、发送和节流更新，显式检查 API 响应码。
- [x] 收尾及流式超时前关闭 streaming_mode；失败时避免重复发送或绕过授权。
- [x] Codex 非 text 模式接入发布器，禁用独立 COT；text 只发送最终结果。

### Task 3: 静态审阅与交付

**Files:** `README.md`、`README.zh.md` 和本计划。

- [x] 记录行为和权限要求；逐条静态审阅 Review Focus。
- [x] 执行 `git diff --check`、重新阅读最终 diff，退出码 0（仅静态检查）。
- [x] 提交本地分支；首次交付未编译、未运行单测、未部署，推送及 PR 因远端授权失败而停止。后续用户完成授权，继续向个人 fork 推送并创建 PR。

## 执行记录

- 使用现有独立 worktree，分支 `codex/fold-thinking`，基线 `98b5060`。
- 依照用户约束跳过技能默认的测试和依赖安装步骤；只做静态检查。
- 独立静态审阅发现的重复发卡、异常过程展开、静默长任务流式关闭、工具偏好清空、final-only 运行态卡片问题已按源码路径修正，未声称运行验证通过。
- 发送直接使用 SDK 原生回复 API，传递按 cardId 固定的 uuid，保留 replyTo 和 replyInThread；不使用 channel.send 的无 UUID 自动重试。
- 过程更新使用尾沿定时刷新，流式关闭使用独立 9 分钟定时器；两者和结束更新共享串行队列，结束或授权失败清理定时器。
- 审阅建议删除授权识别中的 230002，未采纳：官方回复消息文档明确该码表示“机器人不在群中”，属资源可用性边界，不能当普通格式错误继续尝试其他 API。依据：https://open.feishu.cn/document/server-docs/im-v1/message/reply.md 。
- 保留 Codex 事件翻译协议；没有 final_text 的终态不再展开全部过程。单卡片 30KB 是飞书平台限制，已在 README 明示。
- 后续交付：官方 GitHub CLI 已安装，账号 `zbwang163` 授权成功并完成 Git 凭证配置；上游默认分支为 `main` 且只有 READ 权限。个人 fork 为 `zbwang163/lark-coding-agent-bridge`，`master` 保存原始快照 `98b5060`，功能分支 `codex/fold-thinking` 向该基线创建 PR。本次仍未编译、运行单测或部署。
