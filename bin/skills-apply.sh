#!/usr/bin/env bash
# 从 skills.manifest.yml 物化 ~/.dsh/skillsets/<mode>/。默认 dry-run；--apply 才写；--prune 删多余。
set -uo pipefail
exec python3 - "$@" <<'PY'
import sys, os, pathlib, shutil, yaml
args = sys.argv[1:]
DO = "--apply" in args; PRUNE = "--prune" in args
HOME = pathlib.Path(os.environ["HOME"]); SS = HOME/".dsh/skillsets"; SRC = HOME/".dsh/skills"
M = yaml.safe_load((HOME/".dsh/skills.manifest.yml").read_text())
MODES = M["modes"]

def expose_for(cfg, mode):
    return "auto" if mode in (cfg.get("auto_in") or []) else cfg["expose"]
def modes_for(cfg):
    return MODES if cfg["modes"] == ["all"] else cfg["modes"]

want = {}                                   # mode -> {skill: expose}
for mode in MODES: want[mode] = {}
for skill, cfg in M["skills"].items():
    for mode in modes_for(cfg):
        want[mode][skill] = expose_for(cfg, mode)

def actual(mode, skill):
    p = SS/mode/skill
    if p.is_symlink(): return "auto", p
    f = p/"SKILL.md"
    if f.is_file():
        flag = "disable-model-invocation: true" in f.read_text()
        return ("command" if flag else "auto-copy"), p
    return None, p

def materialize(mode, skill, how):
    d = SS/mode; d.mkdir(parents=True, exist_ok=True)
    target = d/skill
    if target.is_symlink() or target.exists():
        if target.is_dir() and not target.is_symlink(): shutil.rmtree(target)
        else: target.unlink()
    if how == "auto":
        target.symlink_to(SRC/skill)
    else:
        shutil.copytree(SRC/skill, target, symlinks=False)
        f = target/"SKILL.md"; s = f.read_text()
        f.write_text(s.replace("---\n", "---\ndisable-model-invocation: true\n", 1))

changes = 0
for mode in MODES:
    for skill, how in sorted(want[mode].items()):
        got, p = actual(mode, skill)
        if got == how and not (how == "auto" and got == "auto-copy"):
            continue
        changes += 1
        print(f"  {mode}/{skill}: {got or '缺'} → {how}")
        if DO: materialize(mode, skill, how)
    if PRUNE:
        for p in sorted((SS/mode).iterdir()) if (SS/mode).is_dir() else []:
            if p.name not in want[mode]:
                changes += 1
                print(f"  {mode}/{p.name}: 多余 → 删除")
                if DO: (p.unlink() if p.is_symlink() else shutil.rmtree(p))

print(f"\n{'已应用' if DO else 'DRY-RUN'}：{changes} 处变更" + ("" if DO else "（加 --apply 才写盘）"))
sys.exit(0)
PY
