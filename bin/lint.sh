#!/usr/bin/env bash
# 分层校验 + 去标识化黑名单。零依赖，CI 可直接跑。
# 用法: bin/lint.sh     退出码 0=全绿 1=有问题
set -uo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"
fail=0
say() { printf '%s %s\n' "$1" "$2"; }
bad() { say "FAIL" "$1"; fail=1; }

# ── 1. 每个规则文件必须有完整 frontmatter ──────────────────────────
REQUIRED=(id title layer visibility)
for f in L0-always-on/*.md L1-scoped/*.md research/*.md; do
  case "$f" in *assemble*|*_template*|*README*) continue;; esac
  [ -f "$f" ] || continue
  head -1 "$f" | grep -qx -- '---' || { bad "$f: 首行必须是 ---"; continue; }
  for k in "${REQUIRED[@]}"; do
    g=$(awk -v k="$k" '/^---$/{n++; next} n==1 && $0 ~ "^"k":" {c++} END{print c+0}' "$f")
    [ "$g" -ge 1 ] || bad "$f: 缺元数据 $k"
  done
done

# ── 2. layer 与所在目录必须一致 ────────────────────────────────────
for f in L0-always-on/*.md; do
  case "$f" in *assemble*|*README*) continue;; esac
  grep -q '^layer: L0' "$f" 2>/dev/null || bad "$f: 在 L0-always-on/ 但 layer 不是 L0"
done
for f in L1-scoped/*.md L1.5-local/*.md; do
  case "$f" in *README*|*.template.md) continue;; esac
  grep -qE '^layer: L1(\.5)?' "$f" 2>/dev/null || bad "$f: 在场景层目录但 layer 不是 L1/L1.5"
done

# ── 3. id 唯一 ─────────────────────────────────────────────────────
dups=$(grep -h '^id:' L0-always-on/*.md L1-scoped/*.md 2>/dev/null | sed 's/^id: *//' | tr -d '"' | sort | uniq -d)
[ -z "$dups" ] || bad "重复 id: $(echo "$dups" | tr '\n' ' ')"

# ── 4. 公开文件不得含本机事实 / 密钥 ───────────────────────────────
# 这些模式命中即失败；需要放本机内容请写进 local/ 或 AGENTS.local.md
BLACKLIST=(
  '/home/[a-z]'                       # 绝对家目录路径
  '([0-9]{1,3}\.){3}[0-9]{1,3}'       # IPv4
  'smb://|ssh .*@|192\.168\.'         # 内网/共享
  '127\.0\.0\.1:[0-9]+'               # 本机端口
  '(API_KEY|SECRET|PASSWORD|TOKEN)='  # 密钥赋值
  'credentials\.yaml|vault/'          # 凭据路径
  '@[a-z0-9-]+\.(com|cn|io|dev)'      # 邮箱/账号
)
# 白名单：示例与占位符
ALLOW='example\.com|localhost|127\.0\.0\.1:port'
for pat in "${BLACKLIST[@]}"; do
  hits=$(grep -rInE -- "$pat" --include='*.md' --include='*.sh' \
         L0-always-on L1-scoped L1.5-local L2-skills L3-guards research incidents 2>/dev/null \
         | grep -vE "$ALLOW" || true)
  [ -z "$hits" ] || bad "黑名单命中 [$pat]:"$'\n'"$hits"
done

# ── 5. local/ 之外不许出现 visibility: local ──────────────────────
hits=$(grep -rIln '^visibility: local' --include='*.md' . 2>/dev/null | grep -v '^./local/' || true)
[ -z "$hits" ] || bad "visibility: local 的文件必须放在 local/:"$'\n'"$hits"

# ── 6. 技能正文不许重抄规则（引用式） ─────────────────────────────
for f in L2-skills/*/SKILL.md; do
  [ -f "$f" ] || continue
  n=$(grep -cE '^\s*(R-[0-9]{2})|R-[0-9]{2}' "$f" || true)
  [ "$n" -ge 1 ] || say "WARN" "$f: 未引用任何 R-id（技能应当在正文里指回规则）"
done

if [ "$fail" -eq 0 ]; then say "OK" "lint 全绿（$(ls L0-always-on/*.md 2>/dev/null | grep -vc assemble) 条规则）"; fi
exit "$fail"
