// pwsh 真判据（tree-sitter 动态 import）+ 缺口1/3/4 的专用测试（2026-10-23）
// 判据来源全部是本机实测：Node v22.22.2 + tree-sitter@0.25.1 + tree-sitter-powershell@0.26.4
//   + shellcheck 0.11.0（~/.local/bin/shellcheck）。
// 末行 PWSH-PARSER GREEN。台账用 env GUARD_STATIC_LOG 指临时文件，测完删。
// 约定：本文件与 run-suite.sh 都**不用管道吃 rc**（上一轮 `node ... | tail` 把 rc 吃成 0 ⇒ marker 假阳性）。
//
// 回退（本轮动手前的快照，原样可粘贴）：
//   cp -p /home/loong/dsh-tool-guard/index.js.bak-20261023-pre-pwsh-parser /home/loong/dsh-tool-guard/index.js
//   cp -p /home/loong/dsh-tool-guard/test/run-suite.sh.bak-20261023-pre-pwsh-parser /home/loong/dsh-tool-guard/run-suite.sh
//   cp -p /home/loong/dsh-tool-guard/test/shellcheck-adapter.mjs.bak-20261023-pre-pwsh-parser /home/loong/dsh-tool-guard/test/shellcheck-adapter.mjs
//   rm -f /home/loong/dsh-tool-guard/test/pwsh-parser.mjs
//   cp -p "/home/loong/文档/Harnessworks/dsh-rules/L3-guards/tool-guard/index.js" /home/loong/dsh-tool-guard/index.js
//   cp -p "/home/loong/文档/Harnessworks/dsh-rules/L3-guards/tool-guard/run-suite.sh" /home/loong/dsh-tool-guard/run-suite.sh
import {
  apply, pwshParserStatus, ensurePwshParser, pwshSyntaxIssues, staticIssuesDetailed,
  nonBashShebang, shellcheckScan, staticNoticeText, DEFAULTS, PWSH_NO_PARSER_NOTICE,
} from "../index.js";
import { readFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

let fail = 0;
const check = (c, m, e = "") => { if (c) console.log(`  ✓ ${m}`); else { fail += 1; console.log(`  ✗ ${m}${e ? "  " + e : ""}`); } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const uniq = `zzq-${process.pid}`;
const SC = "/home/loong/.local/bin/shellcheck";

const staticLog = join(tmpdir(), `guard-pwshp-${process.pid}.jsonl`);
process.env.GUARD_STATIC_LOG = staticLog;
const rows = () => {
  try { return readFileSync(staticLog, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)); }
  catch { return []; }
};
// mock ctx：把 tools/post-execute 监听抓下来（缺口4 的 log 档就靠它把 notices 带给模型）
const mk = (mode, extra = {}) => {
  let g = null; let listener = null;
  apply(
    { tools: { guard: (fn) => { g = fn; return () => {}; }, register: () => () => {} },
      effect: () => {}, on: (ev, fn) => { if (ev === "tools/post-execute") listener = fn; return () => {}; },
      get: () => undefined, logger: { info: () => {}, warn: () => {} } },
    { logFile: join(tmpdir(), `guard-pwshp-${mode}-${process.pid}.log`), requireSnapshot: false, hostServices: [],
      requireTodoEveryMutations: 0, requireTodoEveryMinutes: 0, repeatDenyAt: 0, planFile: "/tmp/none-pwshp.md", stallAt: 0,
      denyNonAsciiPs1: false, denyChainedRegistration: false, denyInlineCredentials: false, denySecretFileRead: false,
      staticCheckMode: mode, staticCheckLogUntil: "2999-01-01", shellcheckPath: SC, ...extra },
  );
  return { guard: g, listener };
};

const BAD_PS = '$x = 1 +\nif ( \nWrite-Host "hi';                      // 实测 root=ERROR
const GOOD_PS = "$x = Get-Process | Where-Object { $_.CPU -gt 1 }\nWrite-Output $x";   // 实测 root=program
const PY = `#!/usr/bin/env python3\nimport os\nprint(1\ncp /etc/definitely-missing-${uniq}.bin /tmp/${uniq}.bin\n`;
const BASH_SYN = "#!/bin/bash\nif [ 1 -eq ; then\n  echo x\nfi\n";      // shellcheck 出 1073/1027/1072
const FALLBACK_SYN = "set -e\nif [ 1 -eq ; then\n  echo x\n";          // 无 fi ⇒ bash -n 也出 E

console.log("=== DEFAULTS 契约（缺口3 + pwsh 开关默认值）===");
{
  check(DEFAULTS.pwshParser === "auto", "DEFAULTS.pwshParser === \"auto\"（pwsh 要真判据）", JSON.stringify(DEFAULTS.pwshParser));
  check(DEFAULTS.shellcheckTimeoutMs === 15000, "DEFAULTS.shellcheckTimeoutMs === 15000（缺口3：原来 5000 撞过线）", JSON.stringify(DEFAULTS.shellcheckTimeoutMs));
  check(typeof DEFAULTS.pwshLoadBudgetMs === "number" && DEFAULTS.pwshLoadBudgetMs > 0,
    "pwshLoadBudgetMs 存在且为正（import 超时预算，非 Config 键）", JSON.stringify(DEFAULTS.pwshLoadBudgetMs));
}

console.log("=== 装载不就绪 ⇒ 显式降级 W（不是通过），force 可重装 ===");
{
  // 用 budgetMs:0 这条确定性入口（实测：热进程里 import 会比 1ms 计时器先到 ⇒ 计时器断言会飘）
  ensurePwshParser("auto", { force: true, budgetMs: 0 });
  await sleep(30);
  const st = pwshParserStatus("auto");
  check(st.available === false && /未装载，非通过/.test(st.reason), "预算 0 ⇒ available:false + reason 写明未装载", JSON.stringify(st));
  const r = pwshSyntaxIssues({ script: BAD_PS, pwshParser: "auto" });
  check(r.available === false && r.issues.length === 1 && r.issues[0].rule === "pwsh-no-parser" && r.issues[0].tier === "W",
    "装载不就绪 ⇒ 一条 pwsh-no-parser W（显式降级，绝不记成通过）", JSON.stringify(r.issues.map((i) => [i.rule, i.tier])));
  ensurePwshParser("auto", { force: true });
  await sleep(250);
  check(pwshParserStatus("auto").available === true, "force 重装 ⇒ 真判据可用", JSON.stringify(pwshParserStatus("auto")));
}

console.log("=== pwsh 真判据：坏样本出 E、合法样本不出 E ===");
{
  const raw = pwshSyntaxIssues({ script: BAD_PS, pwshParser: "auto" });
  check(raw.available === true && raw.issues.length > 0 && raw.issues.every((i) => i.rule === "syntax" && i.tier === "E"),
    "坏 PowerShell ⇒ syntax E（逐条 rule:\"syntax\" tier:\"E\"）", JSON.stringify(raw.issues.map((i) => [i.rule, i.tier])));
  check(raw.issues.every((i) => i.code === "TS-ERROR"), "逐条 code === \"TS-ERROR\"", JSON.stringify(raw.issues.map((i) => i.code)));
  check(raw.issues.every((i) => /行\d+:\d+/.test(i.text) && /ERROR|MISSING/.test(i.text)),
    "text 里带节点类型与行列（取前 4 个）", JSON.stringify(raw.issues.map((i) => i.text).slice(0, 1)));
  const out = { notices: [], excluded: [] };
  const agg = staticIssuesDetailed({ script: BAD_PS, shell: "pwsh", out });
  const e = agg.filter((i) => i.tier === "E");
  check(e.length === 1 && e[0].rule === "syntax" && Array.isArray(e[0].codes) && e[0].codes.includes("TS-ERROR"),
    "接线后折叠成一条 syntax E，codes 含 TS-ERROR", JSON.stringify(e.map((i) => [i.rule, JSON.stringify(i.codes)])));
  check(e[0].text.includes("tree-sitter-powershell"), "文案写明判据来源（tree-sitter-powershell）", String(e[0].text).slice(0, 70));
  const g = mk("deny", { pwshParser: "auto" });
  const denied = g.guard({ name: "pwsh", arguments: { command: BAD_PS }, agent: { id: "a1" } });
  check(typeof denied === "string" && /TS-ERROR/.test(denied),
    "deny 档：坏 PowerShell 真被拦，拒绝文案带 TS-ERROR", String(denied).slice(0, 90));
  const row = rows().slice(-1)[0];
  check(row && row.shell === "pwsh" && row.tier === "E" && (row.codes || []).includes("TS-ERROR"),
    "台账行：shell=pwsh tier=E codes 含 TS-ERROR", JSON.stringify(row && [row.shell, row.tier, row.codes]));
  const okOut = { notices: [], excluded: [] };
  const ok = staticIssuesDetailed({ script: GOOD_PS, shell: "pwsh", out: okOut });
  check(!ok.some((i) => i.tier === "E"), "合法 PowerShell ⇒ 零 E", JSON.stringify(ok.map((i) => [i.rule, i.tier])));
  check(!ok.some((i) => i.rule === "pwsh-no-parser") && okOut.notices.length === 0,
    "合法样本走的是真判据（没有 pwsh-no-parser W、没有降级可告知）", JSON.stringify([ok.map((i) => i.rule), okOut.notices]));
}

console.log("=== pwshParser:\"off\" ⇒ 无 E + pwsh-no-parser W（显式降级）===");
{
  const off = pwshSyntaxIssues({ script: BAD_PS, pwshParser: "off" });
  check(off.available === false && !off.issues.some((i) => i.tier === "E")
    && off.issues[0].rule === "pwsh-no-parser" && off.issues[0].tier === "W",
    "off ⇒ 无 E、有 pwsh-no-parser W", JSON.stringify(off.issues.map((i) => [i.rule, i.tier])));
  const out = { notices: [], excluded: [] };
  staticIssuesDetailed({ script: BAD_PS, shell: "pwsh", cfg: { pwshParser: "off" }, out });
  check(out.notices.includes(PWSH_NO_PARSER_NOTICE), "off ⇒ out.notices 带「未参与检查（非通过）」", JSON.stringify(out.notices));
}

console.log("=== 缺口1：非 bash shebang ⇒ 跳过 shellcheck（记 W，不是通过）===");
{
  check(JSON.stringify(nonBashShebang("#!/usr/bin/env python3\nx\n")) === JSON.stringify({ interp: "env python3" }),
    "判据：#!/usr/bin/env python3 ⇒ {interp:\"env python3\"}", JSON.stringify(nonBashShebang("#!/usr/bin/env python3\nx\n")));
  check(nonBashShebang("#!/bin/bash\nx\n") === null && nonBashShebang("#!/usr/bin/env bash\nx\n") === null
    && nonBashShebang("#!/usr/bin/env -S bash -eu\nx\n") === null,
    "bash 系（含 env bash / env -S bash -eu）⇒ 不跳过（白名单）", JSON.stringify([nonBashShebang("#!/bin/bash\nx\n"), nonBashShebang("#!/usr/bin/env bash\nx\n")]));
  check(nonBashShebang("echo no shebang\n") === null, "无 shebang ⇒ 照旧交给 shellcheck");
  const out = { notices: [], excluded: [] };
  const items = staticIssuesDetailed({ script: PY, out });
  check(!items.some((i) => i.rule === "syntax" && i.tier === "E"),
    "python 正文喂 shellcheck 不再出 syntax E（SC1036/1088/1065 那批噪声已消）", JSON.stringify(items.map((i) => [i.rule, i.tier])));
  check(items.some((i) => i.rule === "non-bash-shebang" && i.tier === "W"),
    "有 non-bash-shebang W（写明「已跳过…非通过」）", JSON.stringify(items.filter((i) => i.rule === "non-bash-shebang")));
  // 主会话 2026-10-23 复验抓出的 FP：跳过 shellcheck 之后 command-missing 仍按 bash argv0 语义判 ⇒
  // python 行首词 import/print 被报成「PATH 里查不到，多半拼错」并出 E。这条判据在非 bash 脚本上没有语义基础。
  check(!items.some((i) => i.rule === "command-missing" && i.tier === "E"),
    "python 正文不得出 command-missing E（import/print 这类行首词属 argv0 语义不适用）",
    JSON.stringify(items.filter((i) => i.rule === "command-missing").map((i) => [i.tier, (i.text || "").slice(0, 42)])));
  check(items.some((i) => i.rule === "command-missing" && i.tier === "W" && /argv0 语义不适用/.test(i.text)),
    "这类命中降 W 且写明理由（argv0 语义不适用）",
    JSON.stringify(items.filter((i) => i.rule === "command-missing").map((i) => i.tier)));
  const pm = items.filter((i) => i.rule === "path-missing");
  check(pm.length === 1 && pm[0].tier === "E", "自研判据照跑：不存在的绝对源路径 ⇒ 仍出 path-missing E", JSON.stringify(pm.map((i) => i.tier)));
  check(/shebang 指向 env python3/.test(items.find((i) => i.rule === "non-bash-shebang").message),
    "W 文案写明解释器与「已跳过（非通过）」", JSON.stringify(items.find((i) => i.rule === "non-bash-shebang").message));
  check(out.notices.length === 1 && /已跳过 shellcheck/.test(out.notices[0]),
    "notices 带「已跳过 shellcheck…未参与检查（非通过）」", JSON.stringify(out.notices));
  const g = mk("deny", { pwshParser: "auto" });
  const before = rows().length;
  const denied = g.guard({ name: "bash", arguments: { command: PY }, agent: { id: "a1" } });
  check(typeof denied === "string" && /源路径不存在/.test(denied),
    "deny 档：python 脚本靠 path-missing E 拦（不是靠 shellcheck 噪声）", String(denied).slice(0, 80));
  const row = rows().slice(before).find((x) => x.kind !== "exempt");
  check(row && row.rules.includes("non-bash-shebang") && row.rules.includes("path-missing"),
    "台账行 rules 同时含 non-bash-shebang 与 path-missing", JSON.stringify(row && row.rules));
  const g2 = mk("deny", { pwshParser: "auto" });
  const d2 = g2.guard({ name: "bash", arguments: { command: BASH_SYN }, agent: { id: "a1" } });
  check(typeof d2 === "string" && /SC1073/.test(d2) && !/non-bash-shebang/.test(d2),
    "#!/bin/bash 的正常样本照旧出 syntax E（SC1073…），不被新判据豁免", String(d2).slice(0, 90));
}

console.log("=== 缺口3：shellcheck 撞线 ⇒ 显式降级写明「超时 Ns」与新默认 ===");
{
  const big = Array.from({ length: 4000 }, (_, i) => `x${i}=1`).join("\n");
  const sc = shellcheckScan({ script: big, shellcheckPath: SC, shellcheckTimeoutMs: 1 });
  check(sc.available === false && sc.reason === "timeout", "4000 行 + timeout 1ms ⇒ reason=timeout", JSON.stringify(sc.reason));
  check(/超时/.test(sc.issues[0].message) && sc.issues[0].message.includes(String(DEFAULTS.shellcheckTimeoutMs)),
    "降级 message 写明「超时」+ 新默认 15000", JSON.stringify(sc.issues[0].message));
}

console.log("=== 缺口4：notices 让模型看见（log 档不改拦/放，只告知）===");
{
  check(staticNoticeText("log", ["AAA"]).startsWith("显式降级（未拦截，仅告知）"),
    "staticNoticeText(log) 前缀 =「显式降级（未拦截，仅告知）」", JSON.stringify(staticNoticeText("log", ["AAA"])));
  check(staticNoticeText("log", []) === "", "没有 notices ⇒ 空串（不产生多余文案）");
  const { guard, listener } = mk("log", { shellcheckPath: "/nope", pwshParser: "off" });
  check(typeof listener === "function", "apply 注册了 tools/post-execute 监听（非拦截通道）", typeof listener);
  const before = rows().length;
  // 宿主里 guard 与 tools/post-execute 拿到的是**同一个 exec 对象**（实测 dsh-tools/lib/index.js 全程传同一实例）
  // ⇒ 这里也必须用同一个对象，否则 WeakMap 对不上（对不上就是"告知没送达"的现场形状）。
  const exec = { name: "bash", arguments: { command: FALLBACK_SYN }, agent: { id: "a1" } };
  const r = guard(exec);
  check(r === undefined, "mode=log ⇒ 处置段不返回文本（拦/放判定没被 notices 改动）", typeof r);
  const row = rows().slice(before).find((x) => x.kind !== "exempt");
  check(row && row.decision === "log" && (row.notices || []).length > 0,
    "台账行：decision=log 且 notices 非空", JSON.stringify(row && [row.decision, row.notices]));
  const decision = await listener(exec, { content: [], isError: false }, async () => ({ kind: "accept" }));
  const text = ((decision.additionalContexts || [])[0]?.content || [])[0]?.text || "";
  check(decision.kind === "accept" && /未拦截，仅告知/.test(text),
    "post-execute 返回 accept + additionalContexts 文案含「未拦截，仅告知」", JSON.stringify([decision.kind, text.slice(0, 70)]));
  check(/shellcheck 未就绪/.test(text), "告知内容里就是那条显式降级文案", text.slice(0, 120));
  const g = mk("deny", { shellcheckPath: "/nope" });
  const d = g.guard({ name: "bash", arguments: { command: FALLBACK_SYN }, agent: { id: "a1" } });
  check(typeof d === "string" && /显式降级/.test(d) && /语法判据本轮失明/.test(d),
    "deny 档：拒绝文案里继续带「显式降级」+ 降级文案（原有形态不变）", String(d).slice(0, 90));
  const d2 = g.guard({ name: "bash", arguments: { command: "echo ok\n" }, agent: { id: "a1" } });
  check(d2 === undefined, "干净脚本 + shellcheck 缺失 ⇒ 不拦（只显式降级）");
}

try { unlinkSync(staticLog); } catch { /* 临时台账没写成就没得删 */ }
console.log(`\n失败 ${fail}`);
console.log(fail === 0 ? "PWSH-PARSER GREEN" : "PWSH-PARSER RED");
process.exit(fail === 0 ? 0 : 1);
