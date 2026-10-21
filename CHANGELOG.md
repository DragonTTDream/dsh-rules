# 变更记录

格式参照 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)；版本号按"规则集语义"走。

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
