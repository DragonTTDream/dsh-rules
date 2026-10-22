---
id: R-07
title: 资源与安全红线
layer: L0
basis: inferred   # documented=有原始记录；inferred=日期不可考，按归档日回填
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
  （资源仲裁插件的 `memFloorMB` / `freeRunMB`）。余量不足先降档，不碰模型。
- 卸载资源**用谁卸谁**，禁止全局卸载。
- 禁止杀宿主进程、服务进程、用户浏览器。
- **重活窗口（`arbitrate_run`）**：`timeoutSec` ≤ 900（更长拆窗）；**禁止用管道包脚本**
  （`| tail` 会缓冲到 EOF ⇒ 整段零输出）；脚本自己写带时间戳的进度文件并在提交前报路径；
  中断/超时后收尾（EXIT trap 杀掉自己起的引擎，没写就在报告里说"有残留"）。
- **单窗口**：本机只有一条推理序列，同一时刻只允许一个重活窗口；并行不会更快，只会互相抢资源。
  窗口形态的完整纪律见技能 `arbitrate-serial-work`。
- 判断权不外包 —— 见 R-15（委派）。
