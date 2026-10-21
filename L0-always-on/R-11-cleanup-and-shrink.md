---
id: R-11
title: 临时文件即清、记忆瘦身
layer: L0
kind: preference
visibility: public
since: 2026-09-23
why: 记忆文件写成了历史长文，每轮注入都在为已经不成立的状态付费
evidence: incidents/INC-2026-09-23-memory-bloat.md
judge: 这条记忆描述的是"当下现实"还是"历史过程"？
enforced_by: [prompt, skill]
---

## 规则

- 任务收尾即清**中间物**（定义与清单见 L2 技能 workspace-hygiene）；**范围外优先清、必清**。
- 有结论的中间物**先压缩成事实进档，再删**。
- 记忆文件只写**当下现实**；已被冷档覆盖的段落**整段下沉**，热档只留指针。
  热档声明的条数 / 体积上限是**硬闸门**——收尾时数一遍，超即下沉，不靠自觉。
- 会话性质由用户声明：**未声明默认保留**，不擅自删除。
