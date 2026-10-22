# 变更记录

格式参照 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)；版本号按"规则集语义"走。

## [v0.7] — 2026-10-23

### 新增
- **R-16 长任务保底与空转收尾**：长任务开局 `create_goal`（带 `max_goal_rounds`）；下一步必须落成工具调用；
  压缩后第一轮先重述再动作；怀疑"停了"用 `~/.local/bin/stall-check` 指名到 turn/step。

### 修复
- 事故 `INC-2026-10-23-reasoning-only-stall`：压缩后模型只回 14 token reasoning 就结束回合，
  会话静默停 53 分钟（`turn/end` reason=completed，无 tool 块）。社区同类：Copilot CLI #3239、
  OpenHands SDK #3992、Stop Hook Auto-Continue Pattern。

## [v0.6] — 2026-10-21

### 修复
- **软提示按"调用次数"计 = 误伤**。实测 6 分钟内两次委派提示命中的都是
  `sed -i` 与"跑脚本"（不是侦察），模型为了消提示而硬派子代理 = 指标驱动。
  - 委派提示改为只数**读类命令**（cat/tail/grep/find/curl/ssh/openfiles…），
    键 `nudgeDelegationAfterReads`；旧的按次数版默认关。
  - 卡片提示改为**时间驱动**（距上次 `todo_write` 的分钟数），键 `nudgeTodoAfterMinutes`。
- 运维事实：`tool=subagent` 的拒绝始终是 0 条 —— 守卫从未挡过子代理本身，挡的是 bash。

## [v0.5] — 2026-10-21

### 变更
- `code-edit-lane` 技能：新增「选哪个 worker」选型表（clone-worker / clone-offline / clone-scout）；
  闸门红了改走 `bin/retry-spec.sh`（失败证据自动回灌，禁止"再试一次"）；
  收尾记成本 `bin/cost-log.sh` → `out/cost.tsv`（含 cache_read 命中率）。
- 新增实测结论：每批新建会话 ⇒ **前缀缓存不跨批**；单会话累计 input 2.0–2.4M token ⇒
  「减少步数」比「复用前缀」更值钱。

### 依据
SWE-agent ACI（接口宽度决定表现）、Aider repo map（自动位置索引）、GitHub Spec Kit（证据先于实现）。

## [v0.4] — 2026-10-21

### 变更
- `R-15 委派三交代` 补三条「必须派」硬条件（≥5 文件只读侦察 / ≥3 个独立核对 /
  ≥2 万 token 原文只取结论），判据从「任务重不重」改成「读入量 ÷ 回传量」。
  起因：纪律七条里四条在劝退，子代理从未真正被用过。
- 新增 `templates/delegate.md`：范围 / 判据 / 输出 schema 三段填空 + 填好的例子。

## [v0.3] — 2026-10-21

### 新增
- 技能 `debug-discipline`：Agans 九条 + 三阶段勾选 + 症状自查
- `L4-plugins/`：self-recall、vision-forward 收录（脱敏版）
- `L4-plugins/rules-by-glob/DESIGN.md`：按扩展名附加规则的可行性与代价结论
- `bin/sync-check.sh`（仓库副本 vs 本机真源的漂移检测）、`bin/index.sh`（事故反向索引）
- CI：`.github/workflows/lint.yml`

### 变更
- L0 从 14 章改为 15 条 R-id；合并 3 处、下沉 4 处、标出 3 条 `kind: preference`
- 消除 4 处模棱两可（非平凡/关键节点/轻量余量/简报）
- `code-edit-lane` 五条 → 八条（规格过闸、失败落盘、三次改判停 lane）
- 技能去重：`process-shell-safety` 97→86 行，`workspace-hygiene` 137→133 行
- 规则元数据新增 `basis`（documented / inferred），纠正 14 条 `since` 同日的问题

### 修复
- `R-08` 的 `evidence` 悬空引用（`09-23` → `10-03`）
- guard 日志明文口令泄漏（清洗 10 处 + `redact()` + 权限 600）

## [v0.1] — 2026-10-21

首个版本：L0–L3 分层骨架、15 条常驻规则、事故台账、`tool-guard` 开源。
