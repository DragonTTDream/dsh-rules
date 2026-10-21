# 变更记录

格式参照 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)；版本号按"规则集语义"走。

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
