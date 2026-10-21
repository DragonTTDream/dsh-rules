#!/usr/bin/env bash
# 技能触发测试（无模型，纯词面）。
#   ① 触发词重叠：两个技能的 description+whenToUse 若高度重叠，模型会选错 → WARN
#   ② 断言集：L2-skills/triggers.tsv 里每句用户原话，argmax 必须等于期望技能
# 用法: bin/skill-triggers.sh     退出码 0=全过 1=有断言失败
set -uo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
exec python3 - "$ROOT" <<'PY'
import sys, pathlib, re, itertools
root = pathlib.Path(sys.argv[1])
skills = {}
for d in sorted((root/"L2-skills").iterdir()):
    f = d/"SKILL.md"
    if not f.is_file(): continue
    s = f.read_text()
    txt = " ".join(re.findall(r'^(?:description|whenToUse):\s*(.+)$', s, re.M))
    skills[d.name] = txt

def grams(t):
    t = re.sub(r'[^\w\u4e00-\u9fff]+', ' ', t.lower())
    toks = []
    for w in t.split():
        if re.search(r'[\u4e00-\u9fff]', w):
            toks += [w[i:i+2] for i in range(len(w)-1)]
        else:
            toks.append(w)
    return set(toks)

G = {k: grams(v) for k, v in skills.items()}

print("=== ① 触发词重叠（Jaccard > 0.15 视为会互相抢（当前实测最高 0.056，余量充足））===")
pairs = 0
for a, b in itertools.combinations(sorted(G), 2):
    inter = len(G[a] & G[b]); uni = len(G[a] | G[b])
    j = inter/uni if uni else 0
    if j > 0.15:
        pairs += 1
        print(f"  WARN {a} ↔ {b}: {j:.2f}")
if not pairs: print("  OK 没有技能之间触发词高度重叠")

def best(phrase):
    gp = grams(phrase)
    if not gp: return None, 0.0
    scored = sorted(((len(gp & G[k])/len(gp), k) for k in G), reverse=True)
    return scored[0][1], scored[0][0]

tf = root/"L2-skills/triggers.tsv"
rows = [l.split("\t") for l in tf.read_text().splitlines() if l.strip() and not l.startswith("#")]
print(f"\n=== ② 断言集（{len(rows)} 句）===")
fail = 0
for phrase, want in rows:
    got, score = best(phrase.strip())
    ok = got == want.strip()
    if not ok: fail += 1
    print(f"  {'✓' if ok else '✗'} {phrase.strip():24} → {got} ({score:.2f})"
          + ("" if ok else f"  期望 {want.strip()}"))
print(f"\n失败 {fail} / {len(rows)}")
sys.exit(1 if fail else 0)
PY
