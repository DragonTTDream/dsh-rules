// 生成物静态检查（2026-10-22）：错误在不执行时就能判出来。
//   A1 语法：bash -n（只解析不执行）
//   A3 命令存在性：段首命令词在 PATH 里查不到
//   A2 源路径存在性（最窄版）：只查 scp/cp 的绝对字面源，且「父目录在、文件不在」
// 灰度：staticCheckMode = off | log（只记日志）| deny（拦）。
import { apply, syntaxIssue, missingCommands, missingSourcePaths, staticCheckIssues } from "../index.js";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

let fail = 0;
const check = (c, m, e = "") => { if (c) console.log(`  ✓ ${m}`); else { fail += 1; console.log(`  ✗ ${m}${e ? "  " + e : ""}`); } };

console.log("=== A1 语法 ===");
const bad = 'for i in 1 2 3; do echo "item $i"; if true; then echo done';
check(typeof syntaxIssue(bad) === "string", "缺 fi/done ⇒ 报语法错", String(syntaxIssue(bad)).slice(0, 80));
check(syntaxIssue('for i in 1 2 3; do echo "item $i"; done') === undefined, "完整循环 ⇒ 通过");
check(syntaxIssue("ls -l") === undefined, "短单行不 spawn（直接放行）");
check(syntaxIssue("echo hi") === undefined, "负样本：短命令不误报");

console.log("=== A3 命令存在性 ===");
check(missingCommands("nosuchcmd-xyz --flag 1").length === 1, "不存在的命令 ⇒ 命中");
check(missingCommands("ls -la /tmp; git status; printf ok").length === 0, "常见命令 ⇒ 不误报");
check(missingCommands("nosuch-xyz && ls").length === 1, "段首字面词才判");
check(missingCommands("echo 'nosuchcmd-xyz inside quotes'").length === 0, "引号内（远端/载荷）不判 ⇒ 关键防误杀");
check(missingCommands("ssh host 'nosuchcmd-xyz; other-cmd'").length === 0, "ssh 引号载荷不判");

console.log("=== A2 源路径（最窄版）===");
check(missingSourcePaths("scp /tmp/definitely-missing-xyz.bin host:/d/a.bin").length === 1, "绝对字面源不存在 ⇒ 命中");
check(missingSourcePaths("cp /tmp/definitely-missing-xyz.bin /tmp/ok.bin").length === 1, "cp 源不存在 ⇒ 命中");
check(missingSourcePaths("scp host:/d/a.bin /tmp/a.bin").length === 0, "远端源 host:path ⇒ 不判");
check(missingSourcePaths("scp /tmp/$NAME.bin host:/d/a.bin").length === 0, "含变量 ⇒ 不判");
check(missingSourcePaths("scp /tmp/*.bin host:/d/a.bin").length === 0, "含通配 ⇒ 不判");
check(missingSourcePaths("scp /no-such-dir-xyz/a.bin host:/d/a.bin").length === 0, "父目录不存在 ⇒ 不冒判（可能还没创建）");
check(missingSourcePaths("scp ~/x.bin host:/d/a.bin").length === 0, "~ 展开 ⇒ 不判");

console.log("=== 汇总：语法错时不叠噪声 ===");
const issues = staticCheckIssues({ script: 'for i in 1 2; do echo "$i"; nosuchcmd-xyz' });
check(issues.length === 1 && /语法错/.test(issues[0]), "只报语法错，不叠加后两项", JSON.stringify(issues).slice(0, 120));

console.log("=== 接入守卫（deny / log / off 三档 + 命中台账）===");
const staticLog = join(tmpdir(), `static-log-${process.pid}.jsonl`);
process.env.GUARD_STATIC_LOG = staticLog;
const readLog = () => {
  try { return readFileSync(staticLog, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)); }
  catch { return []; }
};
const mk = (mode) => {
  let g = null;
  apply(
    { tools: { guard: (fn) => { g = fn; return () => {}; }, register: () => () => {} }, effect: () => {}, on: () => () => {}, get: () => undefined,
      logger: { info: () => {}, warn: () => {} } },
    { logFile: `/tmp/sc-${mode}-${process.pid}-${Math.random().toString(36).slice(2)}.log`, requireSnapshot: false, hostServices: [],
      requireTodoEveryMutations: 0, requireTodoEveryMinutes: 0, repeatDenyAt: 0, planFile: "/tmp/none-sc.md", stallAt: 0,
      denyNonAsciiPs1: false, denyChainedRegistration: false, denyInlineCredentials: false, denySecretFileRead: false,
      staticCheckMode: mode, staticCheckLogUntil: "2999-01-01" },   // 钉住灰度到期日：否则 2026-10-29 之后 log 档会被自动抬成 deny，本用例变红
  );
  return g;
};
{
  const g = mk("deny");
  const before = readLog().length;
  const r = g({ name: "bash", arguments: { command: bad }, agent: { id: "s1" } });
  check(typeof r === "string" && /静态检查命中/.test(r), "deny 档：语法错被拦", String(r).slice(0, 60));
  const rows = readLog();
  check(rows.length === before + 1 && rows[rows.length - 1].decision === "deny", "deny 档：命中落台账（decision=deny）");
  check(g({ name: "bash", arguments: { command: "ls -la /tmp" }, agent: { id: "s1" } }) === undefined, "deny 档：正常命令放行");
}
{
  const g = mk("log");
  const before = readLog().length;
  check(g({ name: "bash", arguments: { command: bad }, agent: { id: "s1" } }) === undefined, "log 档：同样的错只记日志、不拦（灰度）");
  const rows = readLog();
  check(rows.length === before + 1 && rows[rows.length - 1].decision === "log", "log 档：命中同样落台账", JSON.stringify(rows[rows.length - 1] || {}).slice(0, 120));
}
{
  const g = mk("off");
  const before = readLog().length;
  check(g({ name: "bash", arguments: { command: bad }, agent: { id: "s1" } }) === undefined, "负样本：off 档不判也不拦");
  check(readLog().length === before, "负样本：off 档不写台账");
}

console.log(`\n失败 ${fail}`);
console.log(fail === 0 ? "STATIC-CHECK GREEN" : "STATIC-CHECK RED");
process.exit(fail === 0 ? 0 : 1);
