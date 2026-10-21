#!/usr/bin/env bash
# 本机 DSH 配置 → 仓库镜像 的单向同步。
#   bin/dsh-sync.sh            # 写：把本机文件拷进 dsh/
#   bin/dsh-sync.sh --check    # 只比对，不写（退出码 1 = 有漂移）
# 只同步"能公开"的文件；含本机路径的（cordis.patch.yml / package.json）不进仓，
# 改用 dsh/profile/presets.md 与 dsh/plugins/wiring.md 这类人读摘要。
set -uo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CHECK=0; [ "${1:-}" = "--check" ] && CHECK=1
H="${HOME}"
pairs=(
  "$H/.dsh/skills.manifest.yml|dsh/skills.manifest.yml"
  "$H/.dsh/profiles/web/preset-tools.yml|dsh/profile/preset-tools.yml"
  "$H/.dsh/snapshots/snap.sh|dsh/tools/snap.sh"
  "$H/.dsh/snapshots/restore.sh|dsh/tools/restore.sh"
)
drift=0
for p in "${pairs[@]}"; do
  src="${p%%|*}"; dst="$ROOT/${p##*|}"
  [ -f "$src" ] || { echo "MISSING 本机没有: $src"; drift=1; continue; }
  mkdir -p "$(dirname "$dst")"
  if [ -f "$dst" ] && cmp -s "$src" "$dst"; then continue; fi
  if [ "$CHECK" -eq 1 ]; then echo "DRIFT   ${p##*|} 与本机不一致"; drift=1
  else cp "$src" "$dst"; echo "SYNC    ${p##*|}"; fi
done
[ "$drift" -eq 0 ] && echo "OK dsh/ 镜像与本机一致"
exit "$drift"
