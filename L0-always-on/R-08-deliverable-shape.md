---
id: R-08
title: 交付分两层
layer: L0
kind: preference
visibility: public
since: 2026-09-23
why: 把全过程日志当汇报，用户要的结论淹没在刷屏里
evidence: incidents/INC-2026-10-03-noise-as-report.md
judge: 用户只看这条消息，能不能在 30 秒内拿到结论？
enforced_by: [prompt]
---

## 规则

- 全文归档进工作区档，**会话里只给简报**。简报的可判定形态：首屏 5 行内给结论；
  对比用表不用散文；大段原文一律进档不贴。
- 结论要可追到来源（时间点 / 原文 / 命令输出）。
- 过程噪音（进度刷屏、重复日志）不进正文。
- **每条实测结论都要标出前提**（版本 / 强度 / 配置），否则数字没有可比性。
