---
id: INC-2026-10-15-kill-self-shell
date: 2026-10-15
status: verbatim
severity: high
layer_missed: L3
rules: [R-07, R-12]
source: 实测踩坑记录
---
## 症状

一条 `pkill -f <模式>` 把调用它的那个 shell 一起杀了，命令"无输出即结束"，
看起来像执行成功。

## 事实

`pkill -f` / `pgrep -f` 匹配的是**完整命令行**，而调用者的 shell 命令行里
就包含那个模式字面串 ⇒ 自匹配。同一模式也可能误杀无关进程。

## 哪层漏了

**L3**。这条约束当年写在技能正文里（提示层），模型仍然会写出来——
它是可静态判定的（命令字符串里有 `pkill -f`），属于"必须下沉"的那类。

## 修补

1. L2 技能补铁律：判进程在不在用 `pidof`，永不用 `pkill -f` / `pgrep -f`。
2. **下沉 L3**：守卫插件对所有 shell 调用做单调检查，命中即拒并回灌原因。

## 回归

守卫矩阵用例：构造含 `pkill -f` / `pgrep -f` / 宽泛 `kill` 的命令，必须被拒；
构造 `pidof` / 精确 PID 的 kill，必须放行。
