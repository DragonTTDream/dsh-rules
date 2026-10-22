#!/usr/bin/env bash
# 复刻 DSH 的指令发现规则，打印"本次会注入哪些指令文件"。
#
# 依据（dsh-agent-instructions/lib/index.js）：
#   projectRoot = 从 cwd 向上找到的**最近 `.git`**；找不到 ⇒ projectRoot = cwd
#   注入范围   = projectRoot → cwd 这条链上的 AGENTS.md / AGENTS.local.md
#   全局       = $DSH_HOME/AGENTS.md 总是注入
# 社区等价物：Claude Code 的 `/memory`、Gemini CLI 的 `/memory show`——
# 那句原话是"failures here are silent"，所以要有一个能当场问"生效了吗"的入口。
#
# 用法: bin/who-instructs.sh [目录]      # 默认当前目录
# 退出码: 0=有工作区指令  2=只有全局（工作区规则一个都没生效）
set -uo pipefail
target=${1:-$PWD}
[ -d "$target" ] || { echo "不是目录: $target" >&2; exit 64; }
target=$(cd "$target" && pwd)

root=$target
note=""
while :; do
  [ -e "$root/.git" ] && break
  parent=$(dirname "$root")
  if [ "$parent" = "$root" ]; then root=$target; note="（向上没有 .git ⇒ projectRoot = cwd）"; break; fi
  root=$parent
done
echo "projectRoot: $root $note"

chain=(); cur=$target
while :; do
  chain=("$cur" "${chain[@]}")
  [ "$cur" = "$root" ] && break
  cur=$(dirname "$cur")
done

found=0
for d in "${chain[@]}"; do
  for f in AGENTS.md AGENTS.local.md; do
    p="$d/$f"
    [ -f "$p" ] || continue
    printf '  + %6s B  %s\n' "$(wc -c <"$p")" "$p"
    found=$((found + 1))
  done
done
g="$HOME/.dsh/AGENTS.md"
[ -f "$g" ] && printf '  + %6s B  %s（全局，总是注入）\n' "$(wc -c <"$g")" "$g"

# 上级目录有指令文件但不在注入链上 = 静默失效的典型形态
above=$(dirname "$root")
while [ "$above" != "/" ] && [ "$above" != "." ]; do
  for f in AGENTS.md AGENTS.local.md; do
    [ -f "$above/$f" ] && echo "⚠ 不在注入链上: $above/$f（要生效：在该目录开会话，或让该目录成为项目根）"
  done
  above=$(dirname "$above")
done

[ "$found" -gt 0 ] && exit 0 || exit 2
