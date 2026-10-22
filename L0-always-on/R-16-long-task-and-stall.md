---
id: R-16
title: 长任务保底与空转收尾
layer: L0
basis: documented
kind: rule
visibility: public
since: 2026-10-23
why: 模型只回 14 token 的 reasoning 就结束回合（压缩后第一轮），会话静默停 53 分钟，用户问「怎么停了」才继续
evidence: incidents/INC-2026-10-23-reasoning-only-stall.md
judge: 长任务开局有 goal 吗？下一步落成工具调用了吗？停了的会话能用 stall-check 指名到 turn/step 吗？
enforced_by: [prompt, script]
---

## 规则

- **长任务开工就挂 goal**：多步/跨轮/等外部结果的任务先 `create_goal(objective, max_goal_rounds)`，
  收尾 `update_goal complete`；续跑靠 `turn/end` 触发。
- **下一步必须是工具调用**：不许只写"我要继续"就收尾；回合结束前自检一次。
- **压缩后第一轮高风险**：先重述任务与下一步，再发动作。
- **怀疑"停了"别猜**：`bin/stall-check [会话id]` 列出"turn/end completed + 无 tool 块 + 输出极小"
  的步；那是**空转收尾**，不是卡死/超时/报错。
- **判据**：一次"停"要么有 goal 在场，要么被 stall-check 指名到 turn/step。
