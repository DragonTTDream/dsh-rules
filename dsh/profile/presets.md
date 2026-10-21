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
