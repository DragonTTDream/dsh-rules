# 5 个 Agent 预设（结构与判据，值用占位符）

> 权威在 `~/.dsh/profiles/web/cordis.patch.yml`（含本机模型 id 与路径，不进公开仓）。
> 本文件只记**结构与人为什么会这么分**，重装时照着重建。

| id | 名称 | 技能根 | 带哪些技能 | 为什么单独存在 |
|---|---|---|---|---|
| `general` | 普通模式（默认） | `skillsets/general` | 10 个（6 auto + 4 command-only） | 日常入口 |
| `chef` | 大厨 | `skillsets/chef` | chef(auto) + 落盘卫生 + 进程安全 | 做菜不需要其它技能，省每轮 token |
| `stock-analysis-report` | 股票分析 | `skillsets/stock-analysis-report` | 股票(auto) + 2 条纪律技能 | 同上 |
| `video-transcribe-pipeline` | 视频转写 | `skillsets/video-transcribe-pipeline` | 视频(auto) + 2 条纪律技能 | 同上 |
| `comfyui-workflow-safety` | ComfyUI 工作流 | `skillsets/comfyui-workflow-safety` | ComfyUI(auto) + 2 条纪律技能 | 同上 |

## 共同设定

- 每个预设 `includeDefaultRoots: false` + 自己的 `customSkillDirs` ⇒ **精确白名单**。
  ⚠️ 含义：**加技能必须改 `skillsets/`（照 manifest 跑 apply），改仓库/改 `~/.dsh/skills` 都不够**。
- 5 个预设共用同一份工具清单（`dsh/profile/preset-tools.yml`，通过 `cordis:include` 挂入）。
- 内置模式（`standard`/`ptc`/`minimal`/`cordis`）一行未动 —— 它们的技能表来自 web-app bundle，
  改了会被下次更新冲掉。

## 纪律技能 vs 任务技能

| 类型 | 例子 | 跨模式？ |
|---|---|---|
| 跨域安全纪律（落盘、进程/shell） | workspace-hygiene、process-shell-safety | ✅ 所有模式都挂 |
| 任务工作方法（调试清单等） | debug-discipline | ❌ 只挂 general —— 四个任务模式各有专属工作 |

## 压缩行为的本机调优（2026-10-22）

| 项 | 值 | 为什么 | 回退 |
|---|---|---|---|
| `compaction-basic.headroomTokens` | `49152`（默认 65536） | 该键会变成 `maxTokens`（预留输出预算）。调低 ⇒ 消息预算 +16K ⇒ 压缩阈值推后 ⇒ **折叠次数减少** | 删掉该 `config:` 块 + 重启 |
| `tool-result-pruner` | `8192 / 4096 / 1024`（未改） | 默认值。`tailChars` 再降会砍掉失败取证的尾部（R-14 依赖 job.log 尾部） | — |

**口径要清楚**：`headroomTokens` 只降**发生频次**，不降**单次摘要耗时**（单次耗时来自摘要模型调用，
键是 `summarizationProvider` / `summarizationModel`；本机刻意不动它，因为换摘要器会丢前缀缓存）。

**验证判据**（改完重启后，跑一个会触发折叠的会话）：
1. 数同一时间窗内的 `compaction/start→end` 次数，与改前基线比；
2. 若次数不变 ⇒ 该会话用的预设没有 include 本文件（`cordis.patch.yml` 里三处 `file://` 引用）。

**已知坑**：`--dump-config` **不会**渲染 include 进来的预设子条目 `config`（只显示 `name` + `disabled`），
所以别拿它当这项的验收闸；`resolveConfig` 也没从插件里导出。

### 两批实验（2026-10-22，本地模型会话实测后定的）

| 批次 | 改动 | 状态 | 为什么这么保守 |
|---|---|---|---|
| A | `compaction-basic.headroomTokens: 49152` | 已上线 | 阈值 163,840 → 180,224，每轮间隔 +16K ⇒ 折叠次数约 −13% |
| B | `tool-result-pruner.headChars: 4096 → 2048`（variant：`thresholdChars` 保持 **8192**、`tailChars` 保持 1024） | 本次 | **不扩大打击面**：8192 以下不截断 ⇒ `read` 工作流（<8K 文件读）保持完整；只把 >8K 大输出的中段从 5K 缩到 ~3K |

**为什么不直接上原方案（threshold 4096 / head 2048 / tail 512）**：
1. `thresholdChars: 4096` 会让 4–8K 的工具结果也被截断——包括我们自己的 `read` 结果，中段行会消失；
2. `tailChars: 512` 会砍掉失败取证的尾巴（R-14 依赖 `job.log` 尾部与 marker）。

### 本地会话基线（改动前，来自本机 transcript）

| 指标 | 实测 |
|---|---|
| 成功折叠 | 17 次，单次 **97–142 s**（中位 ~110 s） |
| 失败折叠 | 4 次，**0 秒**，`prompt` 271,508 / 322,038 / 355,947 token > 262,144 ⇒ `400 request exceeds the context window` |
| 每会话折叠 | 5 次（两个 -256k 会话，全成功） |
| prune 事件 | 3–9 次/会话，**0 成本**（不调模型） |

> ⚠️ 判据提醒：`compaction/end` 带 `error` 的 0 秒折叠 **不是**“便宜的折叠”，是**压了等于没压**。
> 验收必须同时看两项：`summary` 次数 **和** `compaction/end.error` 必须为 0。

### 已知上游缺陷（可提 issue）

`compaction-basic` 的摘要请求**不自带窗口余量**：262,144 的窗口在 prompt 已经 271K 时仍发出去，
被 provider 400 拒绝后整个折叠静默作废。期望行为：先裁到窗口内再摘要，或降级成 prune-only。

### 取证收工（2026-10-22 04:52，目标会话 a0f21958，本地 -256k，853 事件）

| 项 | 实测 |
|---|---|
| 配置加载 | mtime 03:18:41 < 启动 03:19:38；启动后 0 条相关报错 |
| pruner `headChars: 2048` 生效 | 替换后 **3,111** = 2,048 + 39（标记）+ 1,024；两条样本 |
| summary 折叠 | **2 次：89.1 s / 94 s**，`error=None` |
| 失败 | **0**（改动前同口径 4 次 `400 超窗`） |
| prune | 5 次，单次 shadow 3,014–12,491 token |
| 周期间隔 | 836,468 字符 ≈ 239K token（字符法估算） |

**结论**：
1. 加载与生效：**已实证**（不是推断）。
2. 单次耗时：89/94 s 落在改动前 97–142 s 区间内 ⇒ **未见变化**；机制上也预期不变（摘要模型没换）。
3. 折叠频率：1 个间隔 239K，落在基线 127–217K 之上但不显著；**A 的 13% 理论差异被 ±30% 噪声淹没，无法分辨**。
4. 失败数 0：1 会话 2 周期，弱证据，方向正确。

**取证到此为止的理由**：会话文件**不记录 prompt token 数**（只有 step/start|end），
A 的阈值效应（163,840 → 180,224）**无法用现有数据验证**；继续采样不会产生新判据。

工具：`dsh/tools/compaction-stats.sh`；周期法 = 两个 `compaction/end → start` 之间的正文增量。
