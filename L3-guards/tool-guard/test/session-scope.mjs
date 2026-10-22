// 串会话回归（2026-10-22 用户报告：「会话经常跑着跑着看到别的会话的任务」）
// 覆盖三处曾经的进程级 / 全机器级共享状态：
//   ① 卡片闸计数器（原为进程级单例）
//   ② 计划文件（原为 ~/.dsh/plans/active.md 单文件）
//   ③ 用户消息兜底（原 noteUserText 无条件写全局兜底 ⇒ 无 agent 的调用能拿到别人的原话）
import { apply, noteUserText } from "../index.js";
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

let fail = 0;
const check = (c, m, e = "") => {
  if (c) console.log(`  ✓ ${m}`);
  else { fail += 1; console.log(`  ✗ ${m}${e ? "  " + e : ""}`); }
};

const root = mkdtempSync(join(tmpdir(), "scope-"));
const wsA = join(root, "ws-a");
const wsB = join(root, "ws-b");
mkdirSync(wsA, { recursive: true });
mkdirSync(wsB, { recursive: true });

let guard = null;
apply(
  { tools: { guard: (fn) => { guard = fn; return () => {}; }, register: () => () => {} },
    effect: () => {}, on: () => () => {}, get: () => undefined, logger: { info: () => {} } },
  {
    logFile: join(root, "guard.log"),
    requireSnapshot: false,
    repeatDenyAt: 0,
    stallAt: 0,
    hostServices: [],
    requireTodoEveryMutations: 2,          // 连续 2 次改盘没更新卡片 ⇒ 拦
    planFile: join(root, "plans", "{cwd}", "active.md"),
  },
);

const A = { id: "session-A", session: { header: { cwd: wsA } } };
const B = { id: "session-B", session: { header: { cwd: wsB } } };
const w = (agent, n) => ({ name: "write", arguments: { file_path: join(wsA, `f${n}.txt`), content: String(n) }, agent });
const todo = (agent, tag) => ({ name: "todo_write", arguments: { todos: [{ content: tag, status: "in_progress" }] }, agent });

console.log("=== ① 卡片闸计数器按会话隔离 ===");
guard(todo(B, "B-1"));
check(guard(w(B, 1)) === undefined, "B 第 1 次改盘放行（计数 1）");
guard(todo(A, "A-1"));                     // A 更新卡片：旧实现会把 B 的计数清零
const b2 = guard(w(B, 2));
check(b2 === undefined, "B 第 2 次改盘仍放行（计数到阈，尚未拦）");
const b3 = guard(w(B, 3));
check(typeof b3 === "string" && b3.includes("任务卡片过期"),
  "A 刷卡片不清零 B 的计数 ⇒ B 第 3 次改盘被拦", String(b3 || "").slice(0, 60));

console.log("=== ② 计划文件按工作区分片 ===");
const planA = join(root, "plans", wsA.replace(/\//g, "-"), "active.md");
mkdirSync(join(root, "plans", wsA.replace(/\//g, "-")), { recursive: true });
writeFileSync(planA, "---\nstatus: draft\nscope: " + wsA + "\n---\n# A 的方案\n", "utf8");
const aDraft = guard(w(A, 9));
check(typeof aDraft === "string" && aDraft.includes("禁止改盘"), "A 自己的 draft ⇒ 拦 A 的改盘");
const bOther = guard(w(B, 9));
check(bOther === undefined, "A 的 draft 不拦 B（不同工作区）", String(bOther || "").slice(0, 80));

const planB = join(root, "plans", wsB.replace(/\//g, "-"), "active.md");
mkdirSync(join(root, "plans", wsB.replace(/\//g, "-")), { recursive: true });
writeFileSync(planB, "---\nstatus: draft\nscope: " + wsB + "\n---\n# B 的方案\n", "utf8");
const bDraft = guard(w(B, 10));
check(typeof bDraft === "string" && bDraft.includes("禁止改盘"), "B 自己的 draft ⇒ 拦 B 的改盘");

console.log("=== ②b 计划文件由会话自己声明，不靠猜 slug ===");
// 复现 2026-10-22 事故：模型把计划写成 <工作区>/plans/active.md（而不是 ~/.dsh/plans/<slug>/），
// 旧实现只读固定 slug ⇒ 读不到 ⇒ 计划门静默失效。现在：写 plan 文件即登记，之后以它为准。
mkdirSync(join(wsB, "plans"), { recursive: true });
const draftB = "---\nstatus: draft\nscope: " + wsB + "\nsession: session-B\n---\n# B 的方案（写在任务目录）\n";
const wPlanB = (body) => ({ name: "write", arguments: { file_path: join(wsB, "plans", "active.md"), content: body }, agent: B });
const firstWrite = guard(wPlanB(draftB));
check(firstWrite === undefined,
  "写计划文件本身不被自己的 draft 拦住（否则 draft 永远写不进去）", String(firstWrite || "").slice(0, 60));
writeFileSync(join(wsB, "plans", "active.md"), draftB, "utf8");   // 模拟工具真的落下文件
const afterReg = guard(w(B, 21));
check(typeof afterReg === "string" && afterReg.includes("禁止改盘"),
  "登记后：B 的改盘被这份 draft 拦住（旧实现读不到 ⇒ 静默放行）");
const aStill = guard(w(A, 21));
check(typeof aStill === "string" && aStill.includes("禁止改盘"),
  "A 仍被自己那份 draft 拦（两侧互不覆盖，也不是互相干扰）");

console.log("=== ③ 没有 agent 的调用不能吃到别人的原话 ===");
noteUserText(A, "重启吧");
const noAgent = guard({ name: "bash", arguments: { command: "systemctl --user restart dsh-web.service" } });
check(typeof noAgent === "string" && noAgent.includes("需要用户授权"),
  "A 说过「重启」但调用没有 agent ⇒ 仍按没授权处理（fail-closed）");

console.log(`\n失败 ${fail}`);
console.log(fail === 0 ? "SESSION-SCOPE GREEN" : "SESSION-SCOPE RED");
process.exit(fail === 0 ? 0 : 1);
