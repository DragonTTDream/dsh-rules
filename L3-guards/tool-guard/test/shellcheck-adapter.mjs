// shellcheck 适配器 + pwsh 显式降级（2026-10-23 用户批准：bash 语法判据交给 shellcheck 0.11.0）
// 判据全部来自本机实测（~/.local/bin/shellcheck 0.11.0）：函数名 / case 通配 / `rm -rf /`
// / `rm -rf "$dir"` / `rm -rf ${d}/*` / `mkdri /tmp/a` 在 `-s bash -S error` 下 0 条
// ⇒ 破坏性形状与命令存在性两条判据保留自研，本文件同时锁住这条不退化。
// 末行 SHELLCHECK-ADAPTER GREEN。台账用 env GUARD_STATIC_LOG 指临时文件，测完删。
//
// 回退（本轮动手前的快照，原样可粘贴）：
//   cp -p /home/loong/dsh-tool-guard/index.js.bak-20261023-pre-shellcheck /home/loong/dsh-tool-guard/index.js
//   cp -p /home/loong/dsh-tool-guard/test/run-suite.sh.bak-20261023-pre-shellcheck /home/loong/dsh-tool-guard/run-suite.sh
//   rm -f /home/loong/dsh-tool-guard/test/shellcheck-adapter.mjs
//   cp -p /home/loong/dsh-tool-guard/index.js "/home/loong/文档/Harnessworks/dsh-rules/L3-guards/tool-guard/index.js"
//   cp -p /home/loong/dsh-tool-guard/run-suite.sh "/home/loong/文档/Harnessworks/dsh-rules/L3-guards/tool-guard/run-suite.sh"
// 2026-10-23（pwsh 真判据那一轮）本文件的 pwsh 断言按新语义更新过，那一轮的回退快照：
//   cp -p /home/loong/dsh-tool-guard/index.js.bak-20261023-pre-pwsh-parser /home/loong/dsh-tool-guard/index.js
//   cp -p /home/loong/dsh-tool-guard/test/run-suite.sh.bak-20261023-pre-pwsh-parser /home/loong/dsh-tool-guard/run-suite.sh
//   cp -p /home/loong/dsh-tool-guard/test/shellcheck-adapter.mjs.bak-20261023-pre-pwsh-parser /home/loong/dsh-tool-guard/test/shellcheck-adapter.mjs
//   rm -f /home/loong/dsh-tool-guard/test/pwsh-parser.mjs
// 更新点（逐条，默认 pwshParser 从 off 改 auto 之后必须变语义的断言）：
//   1) 「pwshParser 默认 off ⇒ available:false」⇒「默认 auto（本机已装包）⇒ available:true」
//   2) 「pwsh 无解析器 ⇒ pwsh-no-parser W（默认 off）」⇒ 拆成两半：auto 真判据 ⇒ 不记 pwsh-no-parser；
//      pwshParser:"off" ⇒ pwsh-no-parser W + notices
//   3) 「auto 且未装包 ⇒ reason=解析器未安装」⇒「off ⇒ reason=config off」+「auto ⇒ available:true」
//   4) pwsh 调用被拦时的文案：原来断言「未参与检查」（解析器没装）⇒ 现在断言 path-missing E 在、
//      且**不再出现**「未参与检查」；台账行 rules 含 path-missing、不含 pwsh-no-parser
//   5) 「pwsh 合法片段 + auto（未装解析器）⇒ 放行」⇒「auto 真判据 ⇒ 放行（判据真跑过）」
// 顶部新增 ensurePwshParser 预约 + 200ms 等待（懒加载 ⇒ 断言要落在确定状态上）。
import {
  apply, shellcheckIssues, shellcheckScan, staticIssuesDetailed, pwshParserStatus, ensurePwshParser,
  SHELLCHECK_MISSING_NOTICE, PWSH_NO_PARSER_NOTICE,
} from "../index.js";
import { readFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

// 2026-10-23 语义更新：pwshParser 默认从 off 改成 auto（用户要真判据），本文件的 pwsh 断言按新语义写。
// 装载是懒加载 ⇒ 这里先预约并等它落地，后面的 pwsh 断言才落在确定状态上（未就绪时只会得到显式降级 W）。
ensurePwshParser("auto", { force: true });
await new Promise((r) => setTimeout(r, 200));

let fail = 0;
const check = (c, m, e = "") => { if (c) console.log(`  ✓ ${m}`); else { fail += 1; console.log(`  ✗ ${m}${e ? "  " + e : ""}`); } };
const uniq = `nope-${process.pid}-x`;
const SC = "/home/loong/.local/bin/shellcheck";
const SYN = "set -e\nif [ 1 -eq ; then\n  echo x\nfi\n";     // shellcheck 出 1073/1027/1072；bash -n 不出错
const FALLBACK_SYN = "set -e\nif [ 1 -eq ; then\n  echo x\n"; // 无 fi ⇒ bash -n 也出 E（兜底判据）
const clean = `set -e\ncheck(){ :; }\ncheck\ncheck extra\ncase "$f" in\n*R-11-x.md) echo hit ;;\nesac\n`;

const staticLog = join(tmpdir(), `guard-scad-${process.pid}.jsonl`);
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
    { logFile: join(tmpdir(), `guard-scad-${mode}-${process.pid}.log`), requireSnapshot: false, hostServices: [],
      requireTodoEveryMutations: 0, requireTodoEveryMinutes: 0, repeatDenyAt: 0, planFile: "/tmp/none-scad.md", stallAt: 0,
      denyNonAsciiPs1: false, denyChainedRegistration: false, denyInlineCredentials: false, denySecretFileRead: false,
      staticCheckMode: mode, staticCheckLogUntil: "2999-01-01", ...extra },
  );
  return g;
};

console.log("=== 判据就绪：shellcheck 接管 bash 语法 ===");
{
  check(shellcheckIssues({ script: clean }).length === 0, "函数名调用 + case 通配 ⇒ shellcheck 0 条（不误报）");
  const items = shellcheckIssues({ script: SYN });
  check(items.length === 3 && items.every((i) => i.rule === "syntax" && i.tier === "E"),
    "if [ 1 -eq ; then ⇒ 三条 E，逐项带 code/line/col", JSON.stringify(items.map((i) => [i.code, i.tier])));
  check(items.some((i) => i.code === 1073), "codes 含 1073", JSON.stringify(items.map((i) => i.code)));
  // bash -n 对 SYN 是通过的（现有测试已证实）⇒ 这条 E 只可能来自 shellcheck：判据确实交出去了
  const d = staticIssuesDetailed({ script: SYN });
  check(d.length === 1 && d[0].rule === "syntax" && d[0].tier === "E",
    "接线后折叠成一条 syntax E（同一问题不两处报）", JSON.stringify(d).slice(0, 120));
  check(Array.isArray(d[0].codes) && d[0].codes.includes(1073) && d[0].codes.includes(1072),
    "折叠条带 codes:[1073,1027,1072]（台账可逐码统计）", JSON.stringify(d[0].codes));
  check(d[0].text.includes("shellcheck -s bash -S error"), "文案写明判据来源与档线", d[0].text.slice(0, 60));
}
{
  // 锁死「-s bash 必带」：不带时 `rm -rf /` 会冒出 SC2148（level=error）⇒ 判据不能因配置漂移变红
  check(shellcheckIssues({ script: "rm -rf /\n" }).length === 0, "`rm -rf /` ⇒ shellcheck 无语法命中（-s bash 生效，无 SC2148 噪声）");
  check(staticIssuesDetailed({ script: 'rm -rf "$dir"' }).every((i) => i.rule !== "syntax"),
    "`rm -rf \"$dir\"` / `rm -rf ${d}/*` 不产语法判据", JSON.stringify(staticIssuesDetailed({ script: "rm -rf ${d}/*" }).map((i) => i.rule)));
  const e = staticIssuesDetailed({ script: "mkdri /tmp/a" }).filter((i) => i.tier === "E");
  check(e.length === 1 && e[0].rule === "command-missing", "命令存在性判据保留自研（shellcheck 不管：mkdri ⇒ 0 条）", JSON.stringify(e));
}

console.log("=== shellcheckSeverity：error 拦、warning 只进台账 ===");
{
  const w = shellcheckIssues({ script: "f=$1; echo $f; cd $x\n", shellcheckSeverity: "warning" });
  check(w.length === 2 && w.every((i) => i.tier === "W") && w.every((i) => i.rule === "syntax"),
    "-S warning 对 f=$1;echo $f;cd $x ⇒ 2 条全 W（2154/2164）", JSON.stringify(w.map((i) => [i.code, i.tier])));
  const g = mk("deny", { shellcheckSeverity: "warning" });
  check(g({ name: "bash", arguments: { command: "f=$1; echo $f; cd $x" }, agent: { id: "a1" } }) === undefined,
    "deny 档 + severity=warning ⇒ W 档不拦（用户批准的中档）");
  const row = rows().slice(-1)[0];
  check(row && row.tier === "W" && Array.isArray(row.codes) && row.codes.includes(2164),
    "台账新行带 codes:[…2164…]", JSON.stringify(row && row.codes));
}

console.log("=== shellcheckExclude：剔除 + 台账留痕 ===");
{
  const s = shellcheckScan({ script: SYN, shellcheckExclude: ["SC1073"] });
  check(!s.issues.some((i) => i.code === 1073) && s.issues.some((i) => i.code === 1027),
    "SC1073 被剔除、其余保留", JSON.stringify(s.issues.map((i) => i.code)));
  check(s.excluded.includes("SC1073"), "扫描结果自带 excluded:[SC1073]", JSON.stringify(s.excluded));
  const g = mk("deny", { shellcheckExclude: ["SC1073", "SC1027", "SC1072"] });
  const before = rows().length;
  check(g({ name: "bash", arguments: { command: SYN }, agent: { id: "a1" } }) === undefined,
    "全码剔除 ⇒ 没有 E ⇒ 不拦（剔除只影响语法判据）");
  const row = rows().slice(before).find((x) => x.kind !== "exempt");
  check(row && Array.isArray(row.excluded) && row.excluded.includes("SC1073") && row.decision === "log",
    "剔除在台账留痕：行里 excluded:[SC1073,…] 且 decision=log", JSON.stringify(row && row.excluded));
  check(shellcheckScan({ script: "f=$1; echo $f; cd $x\n", shellcheckSeverity: "warning", shellcheckExclude: ["2154"] }).excluded.includes("SC2154"),
    "裸数字写法（\"2154\"）也认（与 SC2154 等价）");
}

console.log("=== 降级形态（关键，不许静默）：shellcheck 未就绪 ===");
{
  const items = shellcheckIssues({ script: SYN, shellcheckPath: "/nonexistent-shellcheck" });
  check(items.length === 1 && items[0].rule === "shellcheck-missing" && items[0].tier === "W"
    && /语法判据本轮失明/.test(items[0].message),
    "路径不存在 ⇒ 一条 shellcheck-missing W，message 写明「语法判据本轮失明」", JSON.stringify(items));
  const d = staticIssuesDetailed({ script: FALLBACK_SYN, cfg: { shellcheckPath: "/nonexistent-shellcheck" } });
  check(d.some((i) => i.rule === "syntax" && i.tier === "E") && /bash -n/.test(d.find((i) => i.rule === "syntax").text),
    "shellcheck 缺失 ⇒ 回退 bash -n，语法错样本仍出 E", JSON.stringify(d.map((i) => [i.rule, i.tier])));
  const g = mk("deny", { shellcheckPath: "/nonexistent-shellcheck" });
  const before = rows().length;
  const r = g({ name: "bash", arguments: { command: FALLBACK_SYN }, agent: { id: "a1" } });
  check(typeof r === "string" && /语法判据本轮失明/.test(r),
    "返回文案里出现「语法判据本轮失明」（让模型看见，不是只进台账）", String(r).slice(0, 90));
  check(/显式降级/.test(r) && r.includes(SHELLCHECK_MISSING_NOTICE), "拒绝文案写明「显式降级」+ 固定降级文案");
  const row = rows().slice(before).find((x) => x.kind !== "exempt");
  check(row && Array.isArray(row.notices) && row.notices.join(" ").includes("语法判据本轮失明"),
    "台账行 notices 带降级文案（可审计）", JSON.stringify(row && row.notices));
  const g2 = mk("deny", { shellcheckPath: "/nonexistent-shellcheck" });
  check(g2({ name: "bash", arguments: { command: `nosuchcmd-${uniq} /tmp` }, agent: { id: "a1" } }) !== undefined,
    "shellcheck 缺失不影响 command-missing 判据（照拦）");
  check(pwshParserStatus() && pwshParserStatus().available === true,
    "pwshParser 默认已改 auto（本机装了 tree-sitter）⇒ 装载可用 available:true", JSON.stringify(pwshParserStatus()));
}

console.log("=== pwsh：off 档显式「未参与检查」；auto 档真判据（2026-10-23 语义更新）===");
{
  const ps = `Set-Content -Path a.txt -Value 1\nGet-Content a.txt`;
  const out = { notices: [], excluded: [] };
  const all = staticIssuesDetailed({ script: ps, shell: "pwsh", out });
  check(!all.some((i) => i.tier === "E"), "合法 PowerShell 片段 ⇒ 零 E（真解析）", JSON.stringify(all.map((i) => i.rule)));
  check(!all.some((i) => i.rule === "pwsh-no-parser"),
    "默认 auto 且解析器就绪 ⇒ 不再记 pwsh-no-parser（判据真跑了）", JSON.stringify(all.map((i) => i.rule)));
  check(out.notices.length === 0, "解析器就绪 ⇒ notices 为空（没有降级可告知）", JSON.stringify(out.notices));
  const offOut = { notices: [], excluded: [] };
  const offAll = staticIssuesDetailed({ script: ps, shell: "pwsh", cfg: { pwshParser: "off" }, out: offOut });
  check(offAll.some((i) => i.rule === "pwsh-no-parser" && i.tier === "W"),
    "pwshParser:'off' ⇒ pwsh-no-parser W（显式降级，不是通过）", JSON.stringify(offAll.map((i) => i.rule)));
  check(offOut.notices.includes(PWSH_NO_PARSER_NOTICE), "off 档 out.notices 带「未参与检查（非通过）」", JSON.stringify(offOut.notices));
  check(pwshParserStatus("off").available === false && /config off/.test(pwshParserStatus("off").reason),
    "pwshParser:'off' ⇒ available:false + reason=config off", JSON.stringify(pwshParserStatus("off")));
  const gOff = mk("deny", { pwshParser: "off" });
  const rOff = gOff({ name: "pwsh", arguments: { command: `cp /etc/definitely-missing-${uniq}.bin /tmp/${uniq}.bin` }, agent: { id: "a1" } });
  check(typeof rOff === "string" && /未参与检查/.test(rOff),
    "off 档 pwsh 调用被拦时，返回文案写明「本轮语法判据未参与检查（非通过）」", String(rOff).slice(0, 120));
  const g = mk("deny", { pwshParser: "auto" });
  const before = rows().length;
  const r = g({ name: "pwsh", arguments: { command: `cp /etc/definitely-missing-${uniq}.bin /tmp/${uniq}.bin` }, agent: { id: "a1" } });
  check(typeof r === "string" && /源路径不存在/.test(r) && !/未参与检查/.test(r),
    "auto 档 pwsh 调用照旧被拦（path-missing E），且不再出现「未参与检查」", String(r).slice(0, 120));
  const row2 = rows().slice(before).find((x) => x.kind !== "exempt");
  check(row2 && row2.shell === "pwsh" && row2.rules.includes("path-missing") && !row2.rules.includes("pwsh-no-parser"),
    "台账行：shell=pwsh + rules 含 path-missing、不含 pwsh-no-parser", JSON.stringify(row2 && row2.rules));
  const g2 = mk("deny", { pwshParser: "auto" });
  check(g2({ name: "pwsh", arguments: { command: ps }, agent: { id: "a1" } }) === undefined,
    "pwsh 合法片段 + auto ⇒ 放行（判据真跑过，不是「未参与检查」）");
}

console.log("=== 调用隔离：没有模块级缓存 ===");
{
  const a = shellcheckScan({ script: SYN }).available;
  const b = shellcheckScan({ script: SYN, shellcheckPath: "/nonexistent-shellcheck" }).available;
  const c2 = shellcheckScan({ script: SYN }).available;
  check(a === true && b === false && c2 === true, "同一模块连续调用互不影响（无单例缓存）", `${a}/${b}/${c2}`);
}

try { unlinkSync(staticLog); } catch { /* 临时台账没写成就没得删 */ }
console.log(`\n失败 ${fail}`);
console.log(fail === 0 ? "SHELLCHECK-ADAPTER GREEN" : "SHELLCHECK-ADAPTER RED");
process.exit(fail === 0 ? 0 : 1);
