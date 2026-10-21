---
id: R-10
title: 建移删留台账
layer: L0
visibility: public
since: 2026-09-23
why: 收尾清理时凭记忆删，删到了不是自己产生的东西
evidence: incidents/INBOX.md
judge: 这条路径在台账里吗？不在 → 不许删
enforced_by: [prompt]
---

## 规则

- 每次 create / move / delete 当场追加一行：
  `时间 <TAB> 操作 <TAB> 绝对路径 <TAB> 交付物|中间物`
- 收尾按台账清理，**只删台账中我产生的路径**，既有文件一律不碰。
