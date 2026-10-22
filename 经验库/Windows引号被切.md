---
status: active
verified_at: 2026-10-22
verify_cmd: skip
verify_sla_days: 90
strength: must
fault_layer: model
fault_why: 知识缺口：Windows 命令行只有字符串，三层引号解析
verify_note: 需 Windows 环境（计划任务/命令行解析），本机 Linux 无法执行
---

# Windows引号被切：命令行是字符串，不是 argv

## 症状

- 计划任务/`schtasks /TR` 里写带空格的路径，程序**毫秒级退出、零输出**
- 参数"看起来对"，但程序收到的 argv 是碎的
- 同一种写法**反复栽**（第 1 次、第 2 次、第 3 次都死在引号上）

## 判据

- 微软 KB 823093：*任务路径含空格时，用 schtasks 创建的任务不会运行*
- exit code `0x2` / `9009`，且程序无任何输出
- 判据：**看到"路径/参数里有空格 + 进程没起来"，先怀疑引号，不要怀疑程序**

## 正解骨架（按稳健度）

**① 最稳：结构化字段，不拼字符串**

```powershell
Register-ScheduledTask -TaskName "TR" -Action (
  New-ScheduledTaskAction -Execute "C:\no-space\runscr.bat" -Argument "--flag"
)
```

`-Execute` 与 `-Argument` 是**两个独立字段**，引号问题不存在。

**② 稳：任务指向无空格路径的 .bat，引号写在 bat 内部**

```bat
@echo off
rem 引号只被 batch 解析一层
start "" "C:\Program Files\App\app.scr" --fullscreen
```

bat 内用 `%~dp0` 定位，别再写一遍绝对路径。

**③ 只能带空格时的兜底**

```cmd
cmd /c ""C:\a b\x.bat""      rem 外层两个双引号是 cmd 的规则
```

## 反例（别再试这个维度）

- `/TR "C:\Program Files\X\a.exe"` —— 三层引号规则（shell → schtasks → CRT），必挂
- 换 `\"` / `'...'` / 加倍引号 —— 都是同一维度的排列组合，不解决解析层数
- 改程序去"容忍畸形参数" —— 程序拿到的是错误的 argv，改它治不了根

## 一句话

**Windows 每个进程只收到一个命令行字符串**（[MS 官方文章](https://learn.microsoft.com/en-us/archive/blogs/twistylittlepassagesallalike/everyone-quotes-command-line-arguments-the-wrong-way)）；能拆成字段就别拼字符串，能放进 bat 就别放进 /TR。

## 边界

只适用 **Windows** 的命令行/计划任务；Linux shell 的引号规则不同，别照搬。
不含 `.bat` 内部转义全套规则；PowerShell 的参数解析另有规则（见 `$args`/`--%`）。
只解释「路径含空格 + 进程没起来」，不解释「进程起来了但参数值不对」。
