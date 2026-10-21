#!/usr/bin/env bash
# 用法: restore.sh <绝对路径> [更多...]  —— 从单槽快照还原
set -euo pipefail
SLOT="$HOME/.dsh/snapshots/latest"
mirror() { printf '%s' "${1#/}" | sed 's|/|__|g'; }  # 2026-10-17 修：tr '/' '__' 每斜杠只换 1 个下划线（tr 按字符映射），与 snap.sh 的双下划线文件名永不相交 ⇒ restore 必报"无快照"
for t in "$@"; do
  m="$SLOT/$(mirror "$t")"
  if [ -f "$m.tar.gz" ]; then tar -xzf "$m.tar.gz" -C "$(dirname "$t")"; echo "已还原目录: $t"; continue; fi
  [ -f "$m" ] || { echo "无快照: $t"; exit 2; }
  cp -a "$m" "$t"; echo "已还原: $t"
done
