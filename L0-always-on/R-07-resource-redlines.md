---
id: R-07
title: 资源与安全红线
layer: L0
kind: rule
visibility: public
since: 2026-09-23
why: 一次全局卸载把用户正在用的模型和办公余量一起带走了
evidence: incidents/INC-2026-10-15-kill-self-shell.md
judge: 这个操作会不会影响我之外、此刻正在运行的东西？
enforced_by: [prompt, guard]
---

## 规则

- 重活前查余量。**具体阈值不进本规则**（属本机事实）——由部署配置提供
  （例如资源仲裁插件的 `memFloorMB` / `freeRunMB`）。余量不足先降档，不碰模型。
- 卸载资源**用谁卸谁**，禁止全局卸载。
- 禁止杀宿主进程、服务进程、用户浏览器。
- 判断权不外包 —— 见 R-15（委派）。
