# 2026-10-22 第三方压缩器 billion-context 为什么起反作用（对上 issue #4033）

> 本文是**独立可读**的交接档：不需要原会话上下文即可续接。
> 原会话只做了一件事——把结论与证据落盘；后续讨论请在别的会话进行。

## 0. 一句话结论

**billion 不是"更好的压缩"，它先无条件关掉 DSH 原生压缩，再用自己的「折叠快照」顶替；
而折叠产物里既没有"最新真实用户消息"这个权威事实，又用系统级指令要求模型「当这次压缩没发生」。
于是模型只能推理重建世界状态 ⇒ 假用户轮 / 重跑已完成的活 / 推理循环。**

根因分两层：**信息层缺锚点 + 指令层禁止确认**。两处都不是配置能补的。

## 1. 现场参数（复现前提，来自 issue #4033 原文）

| 项 | 值 |
|---|---|
| DSH | `0.2.0-rc.2`（`~/.local/lib/node_modules/@deepseek-ai/dsh`） |
| provider / 模型 | `llm` / `strata-swift-iq3xxs-text`，`reasoningEffort: max`（映射 `high`），`maxTokens: 32768` |
| 引擎 | 自研 `strata`，`--max-context 262144`，llama-swap 在 `127.0.0.1:port` 托管（`ttl: 600`） |
| billion | **0.1.201**（npm 最新 0.1.202），服务 `127.0.0.1:port`（bili 监听口） |
| 生效压缩配置 | `compress.modelContextLimit=262144`、`maxContextLimit="60%"`、`nudgeGrowthTokens=50000`、`reasoning.drop=false`、**`dsh.allowDshCompaction=false`（DSH 原生压缩已关闭，压缩全部由 bili 接管）** |
| 证据会话 | `session-a391218f-0ede-43f0-810e-a8cc3ee0e051`，22.6 MB transcript，**107 turn / 4,154 assistant/message** |
| 折叠频率 | `compaction/start→end` **1,023 次**，其中仅 **37 次**落 `compaction/summary` |
| 触发阈值 | `60% × 262,144 ≈ 157K` token |

> 注意：磁盘上的 `dist/index.js` 已含用户自己的 P1–P8 补丁，但**所有观测来自未打补丁的运行实例**
>（服务 00:06:38 启动，文件 01:09:57 才改）。按 0.1.201 官方 tarball 可复现。

## 2. 症状（全部来自同一份 transcript，可复算）

| # | 症状 | 计数 |
|---|---|---|
| 1 | **假用户轮**：折叠后模型认为收到用户消息 `"！"`，用户实际没发 | 多次（用户口头反馈） |
| 2 | **自动续跑已完成的活**：同一 session 内 `arbitrate_run` 提交 **8 次**（seq 21499/22007/22258/22452/23021/23249/23291/23461），第二次起因是「上次构建已完成但上下文被换掉了」 | 8 |
| 3 | **推理循环**：反复推导"用户有没有发新消息"，逐字句 `The user hasn't sent a new message; this is a system reminder about context` | **25 次 / 跨 5 turn**；跨 turn 逐字重复 **16 条 / 102 次**，其中 **1,011 次**在折叠后第一条 assistant 消息里 |
| 4 | **用元文本代替回答**：把 `<system>User sent a short message…</system>` 当回复正文输出 | 3 次（行 23896/23978/24063） |

## 3. 结构根因 A（信息层）：折叠产物没有「最新用户消息」锚点

issue 里查到的：

- `buildCompressSystemPrompt()` 只提供 acpTags / tools / summariesInContext / COMPRESS_PHILOSOPHY；
  `KEEP VERBATIM` 列表中**没有锚点项**；`锚点` 一词在整个 bundle 出现 **0 次**。
- 结果层只回一行 `[Compressed …]`，不带任何"折叠后状态"事实。

⇒ 折叠后模型**无处可查**"当前最新真实用户消息是什么 / 折叠之后有没有新消息"，
只能推理重建 —— 这就是症状 1 与 3 的直接来源。

## 4. 结构根因 B（指令层）：`MARKER_SILENCE_CLAUSE`

`dist/index.js` 原文：

> `Execute these calls silently: … when the tool returns, continue the task directly as if the call had not happened.`

这句是**系统级指令**，与任何"折叠后先确认状态"的宿主纪律**直接对抗**，且优先级更高。
模型于是同时收到两条相反的顶级指令 —— 宿主规则排在后面，形同失效。

**这就是"模型不遵守我们这套纪律"的真因：不是它不听，是它被要求"当没发生"。**

## 5. 结构根因 C（本仓另行查到的，issue 未写）：原生压缩被无条件关掉

`~/.dsh/profiles/web/node_modules/billion-context/CONFIGURATION.zh-CN.md:119` 原文：

> **「dsh 原生压缩现在在所有线路上被无条件拒绝」**
> `allowDshCompaction` 键与 `BILI_ALLOW_DSH_COMPACTION` 环境变量已不存在；
> 唯一存活键 `dsh.authoredCompaction`，默认 **true** —— 「bili 用折叠快照本地应答 dsh 压缩摘要请求而非拒绝」（`:120`）

也就是说：**它不是优化，是替换。** 被替换掉的 DSH 原生 `compaction-basic` 恰好有三样保护：

| DSH 原生 `compaction-basic` 有 | billion 侧 |
|---|---|
| **逐字尾部保留**（`retainRatio` / `retainTokens`，文档写 "Default verbatim-tail fraction"）⇒ 最新用户消息天然在尾部 | 折叠成摘要，锚点消失 |
| **`toolPairingBalancedBefore/After`** 校验 ⇒ `tool_call` 与 `tool_result` 不许被切开 | 按 token 预算切，可能切开配对 |
| 工具结果原文保留到尾部预算 | `guardrails.maxOutputBytes: 50000` 静默截断 |

另有装配风险：`billion-context/dsh.bundle.patch.yml` 自述
"preset 里的嵌套行任何 patch 层都改不到" ⇒ 某些预设下可能**两套压缩同时跑**。

## 6. 因果链（issue + 代码 + 宿主实测三合一）

```
bili 关闭 DSH 原生压缩（allowDshCompaction=false；见 §5）
   ↓
用「折叠快照」应答压缩请求，但 schema 无 latest-user-message 锚点（§3）
   ↓
同时发 MARKER_SILENCE_CLAUSE：as if the call had not happened（§4）
   ↓
模型：不知道最新用户消息 + 被禁止确认状态
   ↓
推理重建 → 假用户轮 / 反复自证（循环）/ 重跑已完成的活（§2）
   ↓
宿主纪律（复述锚点、失败即取证）排在系统指令之后 → 不生效
   ↓
宿主侧怎么改提示都修不动"折叠产物里缺的那条事实"
```

**这是"反作用"的准确定义：把"模型能查到的事实"换成了"模型必须推理的摘要"。**

## 7. 公平评估：它赢在哪、我们为什么不需要

| 它擅长 | 我们的实际 |
|---|---|
| 云端长会话、按 token 计费、窗口吃紧 | 本机 48 GB 模型、`--max-context 262144`、**单序列** |
| 跨 provider 抹平协议差异 | 只跑一个 provider |
| 折叠超长工具输出省 tokens | 纪律**要求**保留原文取证（R-07 / R-14） |

**它解决的问题我们基本没有；它牺牲的恰好是我们最需要的。**

## 8. 五条验收判据（压缩器通用，可直接复用）

> **压缩器只允许折叠「历史」，不允许改写「当下的权威」。**

折叠后必须**一次查得到**：

1. 最新真实用户消息的**逐字原文 + ref**
2. 折叠**之后**有没有新消息到达
3. 摘要里的旧请求标注 `historical, not live instruction`

结构性判据：

4. 必须有**逐字尾部保留**（不是全量摘要）
5. 必须校验 **`tool_call` ↔ `tool_result` 成对**，不得切开

## 9. 宿主侧已完成的对应物（这套问题的另一半解法）

issue 建议的 S1/S2/S4 都是"让折叠产物带锚点"，需要改 bili 自己；
**我们已经在宿主侧做了等价实现，不依赖第三方压缩器**：

| 问题 | 宿主侧对应物 | 位置 |
|---|---|---|
| 用户原话不可考 ⇒ 模型编造 | 工具 **`session_facts`**：返回 harness 记录的逐字文本 + 时间 + 回合号，按 `agent` 隔离 | `~/dsh-self-recall/index.js`（`sessionFactFrom` / `facts: WeakMap`） |
| 纪律要求模型"凭记忆复述" | **R-13 重写**：删除"写出逐字原文"的槽，改为"调 `session_facts` 照抄；查不到就写『本轮无新用户消息』" | `dsh-rules/L0-always-on/R-13-restate-after-compaction.md` |
| 重跑已完成的活 | **尝试台账 + 失败三分 + 预算/熔断**：`~/.dsh/arbitrate/attempts.jsonl`，`previous` 回灌，`decideRerun` | `~/dsh-self-recall/index.js`（`attemptBudget` / `circuitAfter` / `decideRerun`） |
| 失败后直接重跑 | **R-14「失败即取证」**：先读 job.log / marker / 退出码，重跑前必须能说出上次失败在哪一行 | `dsh-rules/L0-always-on/R-14-attribution-first.md` |

**判据**：这三样在 bili 还在时就能拦住 issue 里 8 次重复提交中的大部分 —— 因为它们不依赖上下文记忆，靠磁盘台账。

## 10. 下一步（交给后续会话）

| # | 待办 | 判据 |
|---|---|---|
| 1 | 升级到 0.1.202 后**只复测锚点**：`#3953/#3986` 是否真把「最新用户消息」保住 | 折叠后第一条 assistant 消息里能否逐字复述用户原话；`compaction/summary` 落盘率是否抬升 |
| 2 | 检查 `MARKER_SILENCE_CLAUSE` 是否仍在 | `grep -c "as if the call had not happened" dist/index.js` |
| 3 | 若坚持用第三方压缩器：先在**旁路会话**跑验收判据 §8 五条 | 任一条不满足 ⇒ 不上生产 |
| 4 | 把 §8 五条并入仓库检查脚本（可选） | 作为"压缩器准入"清单，不是 lint |

## 11. 证据获取（复算用）

```bash
# bili 侧：版本与生效配置
node -p "require('~/.dsh/profiles/web/node_modules/billion-context/package.json').version"
grep -n 'MARKER_SILENCE_CLAUSE\|as if the call had not happened' \
  ~/.dsh/profiles/web/node_modules/billion-context/dist/index.js | head

# DSH 侧：原生压缩的两条保护
sed -n '1,40p' ~/.local/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-compaction-basic/lib/index.js
grep -n 'toolPairingBalanced' ~/.local/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-compaction-basic/lib/index.js

# 原始 issue（证据与计数出处）
# https://github.com/ranxianglei/billion-context/issues/4033
```
