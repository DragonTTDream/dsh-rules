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
  （例如资源仲裁插件的 `memFloorMB` / `freeRunMB`）。余量不足先降档，不碰模型。
- 卸载资源**用谁卸谁**，禁止全局卸载。
- 禁止杀宿主进程、服务进程、用户浏览器。
- **重活窗口（`arbitrate_run`）的形态**：
  - `timeoutSec` **≤ 900**；更长的拆窗，别拿 3600 赌一小时。
  - **禁止用管道包脚本**（`| tail` / `| head` / `| tee` 在外层）：插件把 stdout 接进 job.log，
    管道会缓冲到 EOF ⇒ 整段执行期零输出，用户看不出它在干什么。
  - 脚本自己写**带时间戳的进度文件**，**提交前把路径报给用户**——这是唯一的带外眼睛。
  - 中断/超时后要收尾：脚本 EXIT trap 杀掉自己起的引擎；没写就在报告里明确说"有残留"。
- 判断权不外包 —— 见 R-15（委派）。
