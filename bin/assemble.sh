#!/usr/bin/env bash
# 把 L0-always-on/ 下的规则按 id 排序拼成单一 AGENTS.md。
# 拆分是为了人维护，合并是为了机器读——这两件事必须由脚本做，不能手工粘。
# 用法: bin/assemble.sh [输出路径]   默认输出到 stdout
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
OUT="${1:-}"

body() {
  cat <<'HEADER'
# 常驻规则（每轮生效）

> 本文件由 `dsh-rules/bin/assemble.sh` 从 `L0-always-on/` 拼成，**不要手改**。
> 改规则 → 改对应文件 → 重新 assemble。
> 当前场景若有更具体的约定，见该目录的 `AGENTS.md`（场景规则）或
> `AGENTS.local.md`（个人覆盖）——**越具体越优先**。

HEADER
  for f in $(ls "$ROOT"/L0-always-on/R-*.md 2>/dev/null | sort); do
    id=$(awk -F': *' '/^id:/{print $2; exit}' "$f")
    title=$(awk -F': *' '/^title:/{print $2; exit}' "$f")
    printf '## %s %s\n\n' "$id" "$title"
    # 跳过 frontmatter，只留正文；去掉正文里重复的 "## 规则" 小标题
    awk 'BEGIN{n=0} /^---$/{n++; next} n>=2' "$f" \
      | awk 'BEGIN{skip=0} /^## 规则$/{skip=1; next} {print}' \
      | sed '/./,$!d'
    printf '\n'
  done
}

if [ -n "$OUT" ]; then body > "$OUT"; echo "已写入: $OUT"; else body; fi
