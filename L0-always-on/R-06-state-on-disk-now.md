---
id: R-06
title: 结论当场写盘
layer: L0
basis: inferred   # documented=有原始记录；inferred=日期不可考，按归档日回填
kind: rule
visibility: public
since: 2026-09-23
why: 上下文被压缩后只剩摘要，上一轮的计划和拍板全部蒸发
evidence: incidents/INC-2026-09-23-lost-context-plan.md
judge: 这个节点如果现在断电，重启后能从磁盘恢复吗？
enforced_by: [prompt]
---

## 规则

- **下列节点**当场写进档：建目录 / 上线 / 拍板 / 被纠正 / 改方法 / 推翻旧结论。**不攒到最后**。
- **任务卡片（todo）与落盘同节奏更新**：每完成一个可验证动作就更新一次。
  长任务里卡片停在开局版本 = 用户看不到进度（实测一次 42 分钟、108 步的会话，
  `todo_write` 只被调用过 1 次，卡片在旧状态上停了 31 分钟）。
- 会话收尾追加一行：`日期 | 做了什么 | 结论 | 下次`。
- **上下文里的计划不算存在**；压缩后只剩磁盘上的。
