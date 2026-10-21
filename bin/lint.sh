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
         L0-always-on L1-scoped L1.5-local research incidents 2>/dev/null \
         | grep -vE "$ALLOW" | grep -v "lint:allow" || true)  # 行内豁免：讲规则本身而非泄漏
  [ -z "$hits" ] || bad "黑名单命中 [$pat]:"$'\n'"$hits"
done

# ── 4b. L2 技能允许含本机事实，但要提示移植时需替换 ─────────────
n=$(grep -rIoE '([0-9]{1,3}\.){3}[0-9]{1,3}|/home/[a-z]+' L2-skills 2>/dev/null | wc -l)
[ "$n" -eq 0 ] || say "WARN" "L2-skills 含 $n 处本机事实（回环地址/本机路径），换机器使用需自行替换"

# ── 5. local/ 之外不许出现 visibility: local ──────────────────────
hits=$(grep -rIln '^visibility: local' --include='*.md' . 2>/dev/null | grep -v '^./local/' || true)
[ -z "$hits" ] || bad "visibility: local 的文件必须放在 local/:"$'\n'"$hits"

# ── 7. L0 规则的元数据已经"能自动查"的部分（把纪律下沉成机制）─────────
for f in L0-always-on/R-*.md; do
  [ -f "$f" ] || continue
  # 7a 每条规则必须能指到证据文件（防止悬空引用）
  ev=$(awk -F': *' '/^evidence:/{print $2; exit}' "$f")
  case "$ev" in
    ""|*INBOX*) : ;;                      # 允许指向待补台账
    *) [ -e "$ev" ] || bad "$f: evidence 指向不存在的文件: $ev" ;;
  esac
  # 7b judge 必须非空（判据写不出来 = 这条还是"模棱两可"）
  jd=$(awk -F': *' '/^judge:/{print $2; exit}' "$f")
  [ -n "$jd" ] || bad "$f: 缺 judge（这条还不可判定）"
  # 7c kind 只能是 rule / preference
  kd=$(awk -F': *' '/^kind:/{print $2; exit}' "$f")
  case "$kd" in rule|preference) : ;; *) bad "$f: kind 必须是 rule 或 preference（当前: ${kd:-空}）" ;; esac
  # 7d 上下文税闸门：单条 ≥30 行就该拆分或下沉
  lines=$(wc -l < "$f")
  [ "$lines" -le 30 ] || say "WARN" "$f: $lines 行，超过 30 行闸门（考虑拆分或下沉）"
done

# ── 8. 插件 README 四节齐全（把"文档该写什么"从口头纪律变成检查）──────
for f in L4-plugins/*/README.md; do
  [ -f "$f" ] || continue
  for sec in 注入点 失效症状 配置 恢复配方 依赖; do
    grep -q "## $sec" "$f" || bad "$f: 缺一节「$sec」（模板见 templates/_plugin-readme.md）"
  done
done

if [ "$fail" -eq 0 ]; then say "OK" "lint 全绿（$(ls L0-always-on/*.md 2>/dev/null | grep -vc assemble) 条规则）"; fi
exit "$fail"
