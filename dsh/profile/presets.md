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
