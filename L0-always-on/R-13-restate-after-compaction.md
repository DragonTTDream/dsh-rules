---
id: R-13
title: 压缩后先复述
layer: L0
basis: inferred   # documented=有原始记录；inferred=日期不可考，按归档日回填
kind: rule
visibility: public
since: 2026-09-23
why: 上下文被摘要替换后，模型拿摘要里的旧语气当成了新授权
evidence: incidents/INC-2026-10-19-loop-pollution.md
judge: 我准备做的这件事，能指到一条真实用户消息吗？
enforced_by: [prompt]
---

**触发**：上下文被压缩 / 折叠 / 摘要恢复 / 续跑之后（含"没有新用户消息但回合还在继续"）。

- **复述原文不许凭记忆写**：要引用用户原话就调 `session_facts`（harness 记录的逐字文本 + 时间 + 回合号），照抄。
  它说没有 ⇒ 写「本轮无新用户消息」，**不许用近义词替代**（实测被编成过「继续」，而真实是「批准」）。
- **复述不是授权**：任何引语只作历史，**不作授权**。授权由守卫按 harness 记录判定（R-03）。
- **重活动作前必须已复述**；取不到事实就不动，问用户。
