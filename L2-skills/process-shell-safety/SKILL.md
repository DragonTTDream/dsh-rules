---
name: process-shell-safety
description: 进程与 shell 操作的安全约束，覆盖 pkill/pgrep -f 自匹配、宽泛模式误杀无关进程、后台进程随会话退出、切断对话载体、宿主重启连带回收本次调用内的进程与 job、破坏性命令未批准即执行等常见失误。
whenToUse: 执行 kill/pkill/pgrep/重启服务/后台拉起，或编写含进程操作的脚本时使用；命令无输出即结束、脚本自杀、服务重启后掉线时也用。**设计含「重启宿主/服务」的验证闸门、批量更新、带闸门的脚本方案时，动手前就用**——这类设计会切断会话载体。要跑删除/清理/迁移/覆盖写类命令（rm -rf、git reset/clean/stash、dnf remove、DROP/DELETE、格式化），或写这类脚本时，也用。
---
## 用命令行模式挑进程直接杀（禁）

**判据是动作，不是写法。** 同一条命令里同时出现「按模式挑进程」与「kill」⇒ 危险：

- 挑进程：`pgrep -f` / `pkill -f` / `ps … | grep`
- 杀进程：`kill` / `killall` / `xargs kill`
- 白名单豁免：`comm=` / `pidof` / `--pid` / `ppid`

调用者的 shell 命令行里就含着那个模式，**一定会把自己算进匹配集**——写成管道、`$( )`、
`while read` 循环都改变不了这一点（2026-10-22 实测：`kill $(pgrep -f "x.sh")` 把本次调用链一起杀了）。

合法两条路：① 拆成两条命令（先 `pgrep -f` 看清单 → `ps -o pid,ppid,cmd -p <PID>` 核对 → `kill <PID>`）；
② 必须批量时带白名单：`pgrep -f … | while read p; do [ "$(ps -o comm= -p $p)" = <名> ] && kill "$p"; done`。


# 进程与 shell 安全

## 必守四条（正文最前，压缩后只留这段）

1. **判进程在不在用 `pidof`，永不用 `pkill -f` / `pgrep -f`** —— 它们匹配调用者自己的 shell。
2. **杀之前确认目标不是承载你的进程** —— `ps -o pid,ppid,cmd -p <PID>`，父进程是 `containerd-shim`/`systemd`/你的 shell → 停手。
3. **含宿主重启的验证闸门拆成三个独立调用**（见铁律 10）—— 重启会连带杀掉同一调用内启动的脚本与 job。
4. **破坏性动词逐命令批准，绝不自己确认、绝不绕过防线**（见铁律 6–7）。

## 铁律 1：禁止用名字/路径匹配选进程来杀

`pkill -f` / `pgrep -f` 匹配所有进程的完整命令行，**包括运行这条命令的 shell 自己**；Linux 的 `pgrep`/`pkill` 不排除自身与祖先（macOS/FreeBSD 默认排除，按 macOS 直觉写必中招）。

默认 `pidof <可执行文件名>`；`pgrep -x` 只在名字 ≤15 字符时可靠（超长模式返回 0，**真进程在跑也报「不在」**）。判服务用 `systemctl is-active <unit>`，判 harness 管的模型用 `arbitrate_status`。

完整做法（PID 文件、comm 过滤、`pkill -P $$`）与本机踩坑实例见 `references/进程判据.md`。

## 铁律 2：杀之前确认目标不是"承载你的进程"

本机实例：`pkill -f main.py` 杀过 chef 容器后端（容器内也是 `python main.py`）；
`pkill -f "venv/bin/python main.py"` 杀过工具自己的 bash（`[killed by signal: SIGTERM]`），导致后面的重启命令根本没跑、服务掉线。

容器用 `docker restart <name>`，不从外面杀容器内进程。

## 铁律 3：不要提出"切断对话通道"的前提

**Edge 就是本对话（DSH GUI）的载体。** 任何要求"关闭浏览器 / 关闭 Edge / 重启客户端"的方案在本机都是死路：执行它 = 杀死对话本身。

设计任何用户侧动作前先问：**这个动作会不会切断我们之间的通道？** 会 → 换服务端通道。

## 铁律 4：后台启动要脱离会话，且知道脱离的边界

工具 shell 被杀时，普通 `&` 子进程会一起死。用：

```bash
cd /app && setsid ./app --listen 127.0.0.1 --port "$PORT" > app.log 2>&1 < /dev/null &
```

`setsid` 脱离控制终端，`< /dev/null` 断开 stdin。之后**轮询健康端点**确认，不要假设起来了。

**边界**：`setsid` 只解决「随工具 shell 一起死」。**宿主服务重启会切断会话载体，harness 随之回收本次调用内启动的进程与后台 job —— `setsid nohup disown` 同样被回收。** 判据：脚本没写出它约定的结束 marker，就是被回收了。需要跨重启存活，用 systemd unit 交给服务管理器，不要交给本次调用。

## 铁律 5：执行类动作先报备

> 授权见 **R-03**。独有判据：**"无输出"不等于成功** —— 查 `[exit code: N]`，`143` = 被 SIGTERM（很可能自杀）。

## 铁律 6：破坏性动词清单 = 逐命令批准

> 判据见 **R-03** / **R-12**。清单（细目见 `references/破坏性动词清单.md`）：

- **逐命令批准**：递归强删 · git 丢弃（reset/clean/stash/restore）· 包与系统移除 · `dd`/`mkfs`/`killall -9` · 无 WHERE 的 `DELETE`/`UPDATE` 与 `DROP`/`TRUNCATE`
- **Never 级**（确认也不豁免）：未校验变量的递归强删 · 明文密钥外流 · 无谓词 `DELETE/UPDATE` · 关证书校验 · 执行未知来源脚本 · 直接改 `.git/` 内部 · 无界递归遍历 home/配置目录

## 铁律 7：绝不自己确认，绝不绕过防线

> 原则见 **R-03**，静态可判形态已由 L3 守卫拒。手法清单（全禁）：代打 `confirm`/token、`echo confirm |` 喂管道 · 设"关掉检查"的变量 · 调 `*.real` · 绝对路径绕过 wrapper · 破坏性操作放后台。

**审批策略为 never 时审批不弹给用户** ⇒ "确认"只能来自对话里的明确点头，"沙箱没拦"不等于批准。

## 铁律 8：破坏性代码路径先在临时 fixture 上试

新写或改动的破坏性逻辑（`clean` / `reset` / `purge` / `rm` / 覆盖写 / 批量删除脚本），先在 `mktemp -d` 的 fixture 上跑一遍、核对结果，再对真实路径执行。**单元测试全绿不算验证。**

## 铁律 9：动手前看目标，动手前留退路

> 闸门见 **R-12**。动作：删/覆盖前 `ls -la` 核绝对路径、`ps -o pid,ppid,cmd -p <PID>` 核进程、覆盖前读原文件；可恢复优先于消失；动手前 `git status --short` 再备份。

## 铁律 10：含宿主重启的验证闸门 → 拆成三个独立调用

原理见 **R-12**（重启会连带回收同一调用内的脚本与 job）。本技能只留**拆法** —— 顺序固定为三个调用：

1. **执行动作**（安装 / 构建 / 改配置），**调用内不重启**，当场核对产物；
2. **单独一个调用只重启**；
3. **单独一个调用跑测量与判据**。

需要失败回退时，回退配方写进档、在第 3 个调用里判定，**不指望脚本自己回退**。

## 本机清单

容器一律 `docker restart <name>`，不从外面杀容器内进程。各服务端口与正确停止方式见工作区档 `Deepseekword/系统深度体检-2026-10-14.md` §34。
