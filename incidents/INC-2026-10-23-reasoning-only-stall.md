---
id: INC-2026-10-23-reasoning-only-stall
date: 2026-10-23
status: observed
severity: high
layer_missed: L0
rules: [R-16]
source: 会话记录取证（turn 38 step 44）+ stall-check 复现
---

# 2026-10-23 压缩后只回 reasoning，回合静默结束 53 分钟

## 现象

隔壁会话「<项目名>」（`<会话id>`）
05:19:17 之后不动了。用户原话：「怎么停了？」。模型侧当时**以为自己在继续**
（reasoning 原文：`I need to investigate this further. Let me confirm the details.`），
实际已经停住；用户一开口，它在 14 秒内就把 `arbitrate_run(a2-worker)` 发了出去。

## 取证（会话记录 hard evidence）

| 时刻 | 记录 | 内容 |
|---|---|---|
| 05:18:48 | `compaction/summary` + `compaction/end` | 上下文压缩，同一 step 重发请求 |
| 05:19:17 | `assistant/message`（turn 38, step 44） | content 只有 **1 个 reasoning 块**，无正文、无 tool 块；`stopReason=stop`；usage `outputTokens=14` |
| 05:19:17 | `step/end` → `turn/end` | `reason.kind = "completed"` |
| 05:20:11 | 用户「怎么停了？」 | `turn/start`（turn 39） |
| 05:20:25 | `tool/call arbitrate_run` | a2-worker 提交（距用户发言 14 s） |

复现命令：`~/.local/bin/stall-check <会话id>`
→ `turn=38 step=44 out_tokens=14 「I need to investigate this further...」`

## 根因

1. DSH 的回合循环按"**有没有工具调用**"决定下一步：没有 tool 块 ⇒ 认为本轮完成、交还用户。
   模型只写了"我要继续查"，动作没发出来 ⇒ 没有任何东西会接着跑。
2. 该会话**没有 goal**（记录里无 goal 事件）⇒ 没有 `turn/end` 后的自动续轮兜底。
3. 触发点是压缩后的第一轮：模型在压缩摘要上只输出 14 token 就 `stop`（本地模型 + 长上下文的
   退化形态）。

## 处置（已部署）

- 规则 `R-16`：长任务开局 `create_goal`（带 `max_goal_rounds`）；下一步必须落成工具调用；
  压缩后第一轮先重述再动作；怀疑停了用 `stall-check` 指名到 turn/step。
- 工具 `~/.local/bin/stall-check`：判据 = `turn/end completed` + 该轮最后一条 assistant 无 tool 块
  + `outputTokens < 20`（默认）。扫最近 10 个会话时只命中本事故 1 处，误报率可接受。

## 社区对照

同类事故与修法：GitHub Copilot CLI #3239（text-only turn 静默结束）、
OpenHands SDK #3992（`REASONING_ONLY` / `EMPTY` 响应被当完成，弱模型/本地模型尤甚）、
Stop Hook Auto-Continue Pattern（Claude Code 的 Stop hook，连续续跑封顶 8 次）。
