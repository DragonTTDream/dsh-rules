// 静态检查·分级放行样本（2026-10-22 用户逐条批准：分级放行 + 行内豁免 + 可标误报）
// 纯函数 + 接线（守卫 gate）两层；末行 STATIC-SAMPLES GREEN。
//
// 台账用临时文件（本文件内设 process.env.GUARD_STATIC_LOG），跑完删除，不污染 ~/.dsh/static-check.jsonl。
//
// 回退（本轮动手前的快照，原样可粘贴）：
//   cp -p /home/loong/dsh-tool-guard/index.js.bak-20261023-pre-shellcheck /home/loong/dsh-tool-guard/index.js
//   cp -p /home/loong/dsh-tool-guard/test/run-suite.sh.bak-20261023-pre-shellcheck /home/loong/dsh-tool-guard/run-suite.sh
//   cp -p /home/loong/dsh-tool-guard/index.js    "/home/loong/文档/Harnessworks/dsh-rules/L3-guards/tool-guard/index.js"
//   cp -p /home/loong/dsh-tool-guard/run-suite.sh "/home/loong/文档/Harnessworks/dsh-rules/L3-guards/tool-guard/run-suite.sh"
// 上一轮（2026-10-22 分级放行）的快照回退：
//   cp -p /home/loong/dsh-tool-guard/index.js.bak-20261022-pre-static-tier /home/loong/dsh-tool-guard/index.js
//   cp -p /home/loong/dsh-tool-guard/test/run-suite.sh.bak-20261022-pre-static-tier /home/loong/dsh-tool-guard/run-suite.sh
import {
  apply, staticIssuesDetailed, parseStaticExemptions, applyStaticExemptions, staticEffectiveMode, STATIC_RULES,
} from "../index.js";
import { readFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

let fail = 0;
const check = (c, m, e = "") => { if (c) console.log(`  ✓ ${m}`); else { fail += 1; console.log(`  ✗ ${m}${e ? "  " + e : ""}`); } };
const E = (script, shell = "bash") => staticIssuesDetailed({ script, shell }).filter((i) => i.tier === "E");
const W = (script, shell = "bash") => staticIssuesDetailed({ script, shell }).filter((i) => i.tier === "W");
const uniq = `nope-${process.pid}-x`;

// ── 台账临时文件 ──────────────────────────────────────────────────────────────
const staticLog = join(tmpdir(), `guard-tier-log-${process.pid}.jsonl`);
process.env.GUARD_STATIC_LOG = staticLog;
const rows = () => {
  try { return readFileSync(staticLog, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)); }
  catch { return []; }
};
const mk = (mode, extra = {}) => {
  let g = null;
  apply(
    { tools: { guard: (fn) => { g = fn; return () => {}; }, register: () => () => {} }, effect: () => {},
      on: () => () => {}, get: () => undefined, logger: { info: () => {}, warn: () => {} } },
    { logFile: join(tmpdir(), `guard-tier-${mode}-${process.pid}.log`), requireSnapshot: false, hostServices: [],
      requireTodoEveryMutations: 0, requireTodoEveryMinutes: 0, repeatDenyAt: 0, planFile: "/tmp/none-tier.md", stallAt: 0,
      denyNonAsciiPs1: false, denyChainedRegistration: false, denyInlineCredentials: false, denySecretFileRead: false,
      staticCheckMode: mode, staticCheckLogUntil: "2999-01-01", ...extra },
  );
  return g;
};

console.log("=== 形状契约：{ rule, tier, text } ===");
{
  const all = staticIssuesDetailed({ script: "mkdri /tmp/a; nosuchverb-abc" });
  check(all.length > 0 && all.every((i) => STATIC_RULES.has(i.rule) && (i.tier === "E" || i.tier === "W") && typeof i.text === "string"),
    "每项都有 rule∈{syntax,command-missing,path-missing} 且 tier∈{E,W}", JSON.stringify(all[0] || {}));
  check(staticIssuesDetailed({ script: "" }).length === 0 && staticIssuesDetailed({ script: "   " }).length === 0, "空脚本 ⇒ 零命中");
}

console.log("=== 变绿（本轮两类已证实误报 + 4 个已知形态，一律不得进 E）===");
{
  const s = `set -e\ncheck(){ echo ok; }\ncheck\ncheck extra`;
  check(E(s).length === 0, "①脚本内自定义函数被调用 ⇒ 不进 E", JSON.stringify(E(s)));
  check(W(s).some((i) => /本脚本里定义的函数/.test(i.text)), "①记 W 且写明原因=本脚本定义的函数", JSON.stringify(W(s)));
}
{
  const s = `case x in *快照*) : ;; esac`;
  check(E(s).length === 0, "②case 通配模式（单行）⇒ 不进 E", JSON.stringify(E(s)));
  const s2 = `case "$f" in\n*R-11-cleanup-and-shrink.md) echo hit ;;\nesac`;
  check(E(s2).length === 0, "②case 通配模式（台账 FP 原形）⇒ 不进 E", JSON.stringify(E(s2)));
  check(W(s2).some((i) => /case 分支的模式位/.test(i.text)), "②记 W 且写明原因=case 模式位", JSON.stringify(W(s2)));
}
{
  const s = `"$VAR" $x --flag`;
  check(E(s).length === 0, "变量展开形态（\"$VAR\" / $x）⇒ 不进 E", JSON.stringify(E(s)));
  check(W(s).some((i) => /\$x/.test(i.text)), "变量展开记 W（可统计）", JSON.stringify(W(s)));
}
{
  const s = `cp "/tmp/no such file.txt" /tmp/${uniq}.out`;
  check(E(s).length === 0, "带引号路径参数 ⇒ 不进 E", JSON.stringify(E(s)));
}
{
  const s = `cat > /tmp/a.sh <<'EOF'\nnosuchcmd-inside-here -x\nEOF`;
  check(E(s).length === 0, "heredoc 正文里的假命令 ⇒ 不进 E", JSON.stringify(E(s)));
  check(W(s).some((i) => /heredoc 正文/.test(i.text)), "heredoc 正文记 W", JSON.stringify(W(s)));
}
{
  const s = `python3 -c "import json, sys\nprint(sys.argv)"`;
  check(E(s).length === 0, "内联 python 载荷 ⇒ 不进 E（旧版误杀 6 次那形）", JSON.stringify(E(s)));
  const s2 = `for i in 1 2; do ( nosuchcmd-in-subshell ) ; echo "$i"; done`;
  check(E(s2).length === 0, "子 shell 括号内部 ⇒ 不进 E", JSON.stringify(E(s2)));
  check(W(s2).some((i) => /子 shell/.test(i.text)), "子 shell 内部记 W", JSON.stringify(W(s2)));
  const s3 = `command -v nosuchtool-xyz >/dev/null; type nosuchtool-xyz >/dev/null`;
  check(E(s3).length === 0, "command -v / type 的参数位 ⇒ 不进 E", JSON.stringify(E(s3)));
  check(staticIssuesDetailed({ script: `ls -la /tmp; git status; printf ok` }).length === 0, "常见命令 ⇒ 零命中（W 也不记）");
}

console.log("=== 变红（必须 E）===");
{
  const s = `mkdri /tmp/a`;
  const e = E(s);
  check(e.length === 1 && e[0].rule === "command-missing" && /mkdri/.test(e[0].text), "动词拼错 mkdri ⇒ E", JSON.stringify(e));
}
{
  const s = `cp /etc/hostname-${uniq} /tmp/${uniq}.out`;
  const e = E(s);
  check(e.length === 1 && e[0].rule === "path-missing", "绝对字面源不存在（父目录在）⇒ E", JSON.stringify(e));
  check(E(`cp /no-such-dir-${uniq}/a.bin /tmp/a.bin`).length === 0, "父目录也不在 ⇒ 不判（保守不变）");
}
{
  // 注意：`if [ 1 -eq ; then ... fi` 配对完整时 bash -n 是通过的（bash -n 不检查 [ 缺 ]），
  // 所以语法样本用「if 块没有 fi」这一形态——实测 bash -n status=2。
  const s = `set -e\nif [ 1 -eq ; then\n  echo x\n`;
  const e = E(s);
  check(e.length === 1 && e[0].rule === "syntax", "bash 语法错（if 无 fi）⇒ E 且只报语法", JSON.stringify(e));
  check(E(`x=1\necho "unclosed\nls -l`).every((i) => i.rule === "syntax"), "未闭合引号 ⇒ 语法 E（不叠噪声）");
}

console.log("=== pwsh：跳过 syntax 判据 ===");
{
  const s = `Set-Content -Path a.txt -Value 1\nGet-Content a.txt`;
  const all = staticIssuesDetailed({ script: s, shell: "pwsh" });
  check(!all.some((i) => i.rule === "syntax"), "合法 PowerShell ⇒ 不出 syntax 命中", JSON.stringify(all));
  check(!all.some((i) => i.tier === "E"), "合法 PowerShell ⇒ 零 E（cmdlet 不在 PATH 属正常）", JSON.stringify(all));
  const cm = all.filter((i) => i.rule === "command-missing");
  check(cm.length === 2 && cm.every((i) => i.tier === "W" && /非 bash/.test(i.text)) && all.every((i) => i.tier === "W"),
    "pwsh 的命令名只记 W 并写明原因（2026-10-23：同结果里另有 pwsh-no-parser，见下一句）", JSON.stringify(all.map((i) => i.rule)));
  check(all.some((i) => i.rule === "pwsh-no-parser" && i.tier === "W" && /未参与检查/.test(i.text)),
    "2026-10-23 新增：pwsh 默认无解析器 ⇒ pwsh-no-parser W（显式「未参与检查」，不是判过了）", JSON.stringify(all.map((i) => i.rule)));
  check(staticIssuesDetailed({ script: s, shell: "bash" }).some((i) => i.tier === "E"), "同一串当 bash 判 ⇒ 才有 E（shell 参数生效）");
  const bad = `set -e\nif [ 1 -eq ; then\n  echo x\n`;
  check(!staticIssuesDetailed({ script: bad, shell: "pwsh" }).some((i) => i.rule === "syntax"), "pwsh ⇒ 连 bash 语法错也不判 syntax（跳过判据，不是判得准）");
}

console.log("=== 行内豁免：# guard: allow <rule> <原因> ===");
{
  const s = `nosuchverb-${uniq} /tmp\n# guard: allow command-missing 是本脚本里定义的函数`;
  const ex = parseStaticExemptions(s);
  check(ex.length === 1 && ex[0].valid && ex[0].rule === "command-missing" && ex[0].reason.length >= 3, "豁免行解析成功且 valid", JSON.stringify(ex));
  const a = applyStaticExemptions({ issues: staticIssuesDetailed({ script: s }), exemptions: ex });
  check(a.eBlocking.length === 0 && a.exempted.length === 1 && a.w.length >= 0, "生效豁免 ⇒ E 不进拦截", JSON.stringify(a.exempted.map((i) => i.rule)));
  const g = mk("deny");
  const before = rows().length;
  check(g({ name: "bash", arguments: { command: s }, agent: { id: "t1" } }) === undefined, "deny 档 + 有效豁免 ⇒ 放行");
  const exRows = rows().slice(before).filter((r) => r.kind === "exempt");
  check(exRows.length === 1 && exRows[0].rule === "command-missing" && /本脚本/.test(exRows[0].reason), "豁免本身进台账（kind=exempt，可统计次数）", JSON.stringify(exRows));
  check(rows().slice(before).every((r) => r.kind === "exempt"), "被豁免后没有多余的命中行");
}
{
  const s = `nosuchverb-${uniq} /tmp\n# guard: allow command-missing`;
  const ex = parseStaticExemptions(s);
  check(ex.length === 1 && ex[0].valid === false && ex[0].known === true, "缺原因 ⇒ valid=false", JSON.stringify(ex));
  const a = applyStaticExemptions({ issues: staticIssuesDetailed({ script: s }), exemptions: ex });
  check(a.eBlocking.length === 1 && a.invalidExempt.includes("command-missing"), "缺原因 ⇒ 命中照常进可拦集", JSON.stringify(a.invalidExempt));
  const g = mk("deny");
  const before = rows().length;
  const r = g({ name: "bash", arguments: { command: s }, agent: { id: "t1" } });
  check(typeof r === "string" && /豁免无效（缺原因）/.test(r), "缺原因 ⇒ 拦，并写明「豁免无效（缺原因）」", String(r).slice(0, 80));
  const hit = rows().slice(before).find((x) => x.kind !== "exempt");
  check(hit && Array.isArray(hit.exemptInvalid) && hit.exemptInvalid.includes("command-missing"), "台账行记下无效豁免（exemptInvalid）", JSON.stringify(hit || {}).slice(0, 160));
}
{
  // 豁免只关指定 rule：豁免 syntax ⇒ 不放过 command-missing 的 E 命中（照拦，且不报"豁免无效"）
  const s = `nosuchverb-${uniq} /tmp\n# guard: allow syntax 这条我确认过没问题`;
  const g = mk("deny");
  const r = g({ name: "bash", arguments: { command: s }, agent: { id: "t1" } });
  check(typeof r === "string" && /可拦档（E）/.test(r) && !/豁免无效/.test(r), "豁免只关指定 rule：豁免 syntax 不放过 command-missing", String(r).slice(0, 70));
  const g2 = mk("deny");
  const s2 = `# guard: allow command-missing 是本脚本里定义的函数\ncp /etc/hostname-${uniq} /tmp/${uniq}.out`;
  const r2 = g2({ name: "bash", arguments: { command: s2 }, agent: { id: "t1" } });
  check(typeof r2 === "string" && /源路径不存在/.test(r2), "豁免 command-missing ⇒ path-missing 的 E 照拦（逐 rule 生效）", String(r2).slice(0, 70));
  check(parseStaticExemptions(`# guard: allow nosuch-rule 原因原因`).every((e) => e.known === false && e.valid === false), "未知 rule ⇒ 豁免无效（不产生新语义）");
  check(parseStaticExemptions("# guard: allow command-missing   ").every((e) => e.valid === false), "只有空白 ⇒ 豁免无效（去空白后 <3 字）");
}

console.log("=== 灰度：mode=log + staticCheckLogUntil ===");
{
  check(staticEffectiveMode("log", "2020-01-01") === "deny", "mode=log 且 到期日已过 ⇒ 按 deny 处置");
  check(staticEffectiveMode("log", "2999-01-01") === "log", "mode=log 且 未到期 ⇒ 只记不拦");
  check(staticEffectiveMode("log", "下周二") === "log" && staticEffectiveMode("log", "") === "log", "到期日写坏/没写 ⇒ 不自动收紧（不把生产锁死）");
  check(staticEffectiveMode("off", "2020-01-01") === "off" && staticEffectiveMode("deny", "2999-01-01") === "deny", "off/deny 行为不变");
  const bad = `set -e\nif [ 1 -eq ; then\n  echo x\n`;
  const gPast = mk("log", { staticCheckLogUntil: "2020-01-01" });
  const beforePast = rows().length;
  const rPast = gPast({ name: "bash", arguments: { command: bad }, agent: { id: "t1" } });
  check(typeof rPast === "string" && /可拦档（E）/.test(rPast), "到期后 log 档自动按 deny：语法错被拦 + 文案写明 E 档", String(rPast).slice(0, 70));
  check(rows().slice(beforePast).some((x) => x.kind !== "exempt" && x.decision === "deny" && x.tier === "E"), "到期后的台账行 decision=deny tier=E");
  const gFut = mk("log", { staticCheckLogUntil: "2999-01-01" });
  const beforeFut = rows().length;
  check(gFut({ name: "bash", arguments: { command: bad }, agent: { id: "t1" } }) === undefined, "未到期：同样的错只记台账、不拦");
  check(rows().slice(beforeFut).some((x) => x.decision === "log" && x.tier === "E" && x.verdict === "unreviewed"), "未到期的台账行 decision=log tier=E verdict=unreviewed");
}

console.log("=== W 档：mode=deny 也不拦，只落台账 ===");
{
  const g = mk("deny");
  const s = `set -e\ncheck2(){ :; }\ncheck2`;
  const before = rows().length;
  check(g({ name: "bash", arguments: { command: s }, agent: { id: "t1" } }) === undefined, "deny 档 + 只有 W 命中 ⇒ 放行");
  const row = rows().slice(before).find((x) => x.kind !== "exempt");
  check(row && row.tier === "W" && row.decision === "log" && row.shell === "bash" && row.verdict === "unreviewed",
    "W 命中落台账：tier=W decision=log shell=bash verdict=unreviewed", JSON.stringify(row || {}).slice(0, 200));
  check(row && Array.isArray(row.rules) && row.rules.includes("command-missing"), "台账新字段 rule/rules 在位", JSON.stringify(row && row.rules));
}
{
  const g = mk("off");
  const before = rows().length;
  check(g({ name: "bash", arguments: { command: `mkdri /tmp/a` }, agent: { id: "t1" } }) === undefined, "off 档：E 命中也不拦");
  check(rows().length === before, "off 档：不写台账（行为不变）");
}
{
  const g = mk("deny");
  const r = g({ name: "bash", arguments: { command: `mkdri /tmp/a && check3(){ :; }` }, agent: { id: "t1" } });
  check(typeof r === "string" && /可拦档（E）/.test(r) && /W 档·不拦/.test(r), "拒绝文案：写明 E 档 + 把 W 档命中列成提示", String(r).slice(0, 90));
}
{
  const g = mk("deny");
  const r = g({ name: "pwsh", arguments: { command: `Set-Content -Path a.txt -Value 1` }, agent: { id: "t1" } });
  check(r === undefined, "pwsh 合法语法 ⇒ deny 档也放行（接线按 shell 判）");
  const g2 = mk("deny");
  const r2 = g2({ name: "arbitrate_run", arguments: { script: `set -e\nif [ 1 -eq ; then\n  echo x\n` }, agent: { id: "t1" } });
  check(typeof r2 === "string", "arbitrate_run 的脚本也判 syntax（bash）");
}

try { unlinkSync(staticLog); } catch { /* 临时台账没写成就没得删 */ }
console.log(`\n失败 ${fail}`);
console.log(fail === 0 ? "STATIC-SAMPLES GREEN" : "STATIC-SAMPLES RED");
process.exit(fail === 0 ? 0 : 1);
