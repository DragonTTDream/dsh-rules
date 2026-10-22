// 计划门（社区：Claude Code Plan Mode 的权限降级 / Cline Plan&Act / Spec Kit 分阶段）
// 病根（2026-10-22 实测）：守卫拦下"方案层提问"后，模型按"可逆⇒自己定"自决了方案，
// 再转头问"怎么执行"——用户连计划都没看完。方案层不能自决，执行必须由批准后的产物放行。
import { apply, planGate, planState, askGate } from "../index.js";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

let fail = 0;
const check = (c, m, e = "") => { if (c) console.log(`  ✓ ${m}`); else { fail += 1; console.log(`  ✗ ${m}${e ? "  " + e : ""}`); } };

const work = mkdtempSync(join(tmpdir(), "plangate-"));
const mk = (fm) => { const p = join(work, `p${Math.random().toString(36).slice(2)}.md`); writeFileSync(p, `---\n${fm}\n---\n\n# 方案\n`); return p; };

console.log("=== planState：自批不算批 ===");
check(planState(join(work, "nope.md")).exists === false, "文件不存在 ⇒ exists=false");
const draft = mk("status: draft\nscope: 整理项目");
check(planState(draft).status === "draft" && planState(draft).approved === false, "draft ⇒ 未批准");
const selfApproved = mk("status: approved");
check(planState(selfApproved).approved === false, "只写 approved、没有用户逐字消息 ⇒ 视为 draft（自批无效）");
const good = mk("status: approved\napproved_at: 2026-10-22T03:30:00Z\napproved_msg: 批准方案\nscope: 整理项目");
check(planState(good).approved === true, "approved + approved_at + approved_msg ⇒ 真批准");

console.log("=== planGate：draft 期禁改盘（按会话隔离）===");
const D = planState(draft);                                     // 无 session 字段（历史文件）
const S1 = planState(mk("status: draft\nsession: s1\nscope: 整理项目"));
const S2 = planState(mk("status: approved\napproved_at: 2026-10-22T03:30:00Z\napproved_msg: 批准方案\nsession: s2"));
check(typeof planGate({ name: "write", plan: S1, session: "s1" }) === "string", "本会话 draft + write ⇒ 拒");
check(typeof planGate({ name: "edit", plan: S1, session: "s1" }) === "string", "edit ⇒ 拒");
check(typeof planGate({ name: "bash", cmd: "r" + "m -rf /tmp/x", plan: S1, session: "s1" }) === "string", "改盘类 shell ⇒ 拒");
check(typeof planGate({ name: "arbitrate_run", plan: S1, session: "s1" }) === "string", "arbitrate_run ⇒ 拒");
check(planGate({ name: "bash", cmd: "ls -la; cat x", plan: S1, session: "s1" }) === undefined, "只读侦察 ⇒ 放行");
check(planGate({ name: "read", plan: S1, session: "s1" }) === undefined, "read ⇒ 放行");
check(planGate({ name: "write", plan: S2, session: "s2" }) === undefined, "已批准 ⇒ 放行");

console.log("=== 跨会话隔离（2026-10-22 实测死锁的回归用例）===");
check(planGate({ name: "write", plan: S1, session: "s9" }) === undefined, "别的会话的 draft ⇒ 不拦本会话");
check(planGate({ name: "write", plan: D, session: "s1" }) === undefined, "无 session 字段的历史文件 ⇒ 不拦");

console.log("=== askGate：方案层不许自决、不许此刻问 ===");
for (const q of ["Study/Money 947M 怎么处置？", "中间物怎么清理？", "授权范围按哪种给？", "旧快照要不要移走？"]) {
  const r = askGate({ userText: "看看这些", question: q });
  check(typeof r === "string" && r.includes("方案层"), `「${q.slice(0, 12)}…」⇒ 方案层拦截`);
  check(typeof r === "string" && !r.includes("自己定并"), "且拒绝语里没有「自己定」");
}
// 执行细节也会被拦，但拦的方向是「别问，可逆就自己定并说明」——与方案层正相反
const execQ = askGate({ userText: "看看", question: "先跑 B1 还是 B2？" });
check(typeof execQ === "string" && (execQ.includes("[one-way]") || execQ.includes("双行道")), "执行细节 ⇒ 拦，但引导「自己定」而非「等用户」");
check(typeof execQ === "string" && !execQ.includes("方案层"), "且不误判成方案层");

console.log("=== 接入守卫：draft 期写盘被拦 ===");
let guard = null;
apply(
  { tools: { guard: (fn) => { guard = fn; return () => {}; }, register: () => () => {} }, effect: () => {}, on: () => () => {}, get: () => undefined, logger: { info: () => {} } },
  { logFile: `/tmp/plan-${process.pid}.log`, requireSnapshot: false, hostServices: [], requireTodoEveryMutations: 0, repeatDenyAt: 0, stallAt: 0, requireTodoEveryMinutes: 0, planFile: mk("status: draft\nsession: s1\nscope: 接入测试") },
);
const g = guard({ name: "bash", arguments: { command: "git commit -m x" }, agent: { id: "s1" } });
check(typeof g === "string" && g.includes("方案还没定稿"), "本会话 draft ⇒ 拦下并说明方案未定稿");
const gOther = guard({ name: "bash", arguments: { command: "git commit -m x" }, agent: { id: "s9" } });
check(gOther === undefined || !String(gOther).includes("方案还没定稿"), "别的会话 ⇒ 不拦（回归：拦的不能是计划门）");

rmSync(work, { recursive: true, force: true });

console.log(`\n失败 ${fail}`);
console.log(fail === 0 ? "PLAN-GATE GREEN" : "PLAN-GATE RED");
process.exit(fail === 0 ? 0 : 1);