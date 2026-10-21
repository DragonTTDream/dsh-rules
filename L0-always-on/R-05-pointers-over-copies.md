---
id: R-05
title: 跨范围只放指针
layer: L0
visibility: public
since: 2026-09-23
why: 同一份内容被复制到多个地方，改一处另几处就静默过期
evidence: incidents/INC-2026-10-03-wrote-into-others-docs.md
judge: 这份内容会不会在两个地方各存一份？会 → 改指针
enforced_by: [prompt, guard]
---

## 规则

- 产物归属看**领域**：属于哪个范围就进哪个范围。跨范围**只写指针，不复制**。
- 类比不是归属依据（"某物也在这个目录"不构成把新东西塞进去的理由）。
- 根目录不留裸文件，一律进语义化子目录。
- 上层规则指向下层规则时，**只用一行指针**，不把下层的正文抄上来。
