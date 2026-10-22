// 串行护栏单测（2026-10-23 用户令）：窗口返回了、作业却还活着的作业必须被指名。
// 起因：06:09 起的窗口 06:24 到点返回，进程一直跑，主对话同时恢复生成 ⇒ 两个本地客户端
//   分时抢同一条推理序列（引擎 /metrics：reused 98%→0，预填充 2s→44-51s）。
// 判据抽样自磁盘事实（windowReturnedAt / pid / 日志里的 marker），不由被拦调用自报。
import { orphanJobs, agentKey } from "../index.js";

let fail = 0;
const check = (c, m, e = "") => { if (c) console.log(`  ✓ ${m}`); else { fail += 1; console.log(`  ✗ ${m}${e ? "  " + e : ""}`); } };

const now = 1_800_000_000_000;
const rec = (o = {}) => ({ jobId: "w-1", pid: 111, dir: "/tmp/x", logPath: "/tmp/x/job.log", ...o });
const opts = (alive = true, marker = "", graceSec = 5) => ({
  now, graceSec, alive: () => alive, markerOf: () => marker,
});

console.log("=== 窗口还没返回 ⇒ 不管（正常在跑）===");
check(orphanJobs([rec()], opts()).length === 0, "无 windowReturnedAt ⇒ 不算孤儿");

console.log("=== 返回 + 进程仍活 + 没 marker ⇒ 孤儿 ===");
{
  const list = orphanJobs([rec({ windowReturnedAt: now - 60000, windowReason: "timeout" })], opts());
  check(list.length === 1, "命中一条");
  check(list[0].windowReason === "timeout", "原因带出来（写进拦截文案）");
}

console.log("=== 三种「不算孤儿」的出口 ===");
check(orphanJobs([rec({ windowReturnedAt: now - 60000 })], opts(true, "ok")).length === 0, "已写 marker ⇒ 收尾了");
check(orphanJobs([rec({ windowReturnedAt: now - 60000 })], opts(false)).length === 0, "进程已退出 ⇒ 不是孤儿");
check(orphanJobs([rec({ windowReturnedAt: now - 2000 })], opts()).length === 0, "刚返回 2s（grace 5s）⇒ 先给调用方一个回合");

console.log("=== grace 边界 ===");
check(orphanJobs([rec({ windowReturnedAt: now - 5000 })], opts()).length === 1, "整 5s ⇒ 算（边界含）");
check(orphanJobs([rec({ windowReturnedAt: now - 6000 })], { ...opts(), graceSec: 0 }).length === 1, "graceSec=0 ⇒ 立即算");

console.log("=== 多条作业：只挑真孤儿 ===");
{
  const list = orphanJobs([
    rec({ jobId: "done-1", windowReturnedAt: now - 60000 }),           // 有 marker（下面 markerOf 统一 "ok"?）
    rec({ jobId: "live-1", windowReturnedAt: now - 60000 }),
  ], { now, graceSec: 5, alive: (r) => r.jobId === "live-1", markerOf: () => "" });
  check(list.length === 1 && list[0].jobId === "live-1", "只留还活着的那条");
}

console.log("=== 空值兜底 ===");
check(orphanJobs(undefined, opts()).length === 0, "undefined ⇒ 空表，不抛");
check(orphanJobs([null, {}, rec()], opts()).length === 0, "脏记录跳过");
check(orphanJobs([rec({ windowReturnedAt: "abc" })], opts()).length === 0, "时间戳非法 ⇒ 不算（宁漏不误掐）");

console.log("=== 会话身份 ===");
check(agentKey({ session: { id: "ses_1" } }) === "ses_1", "从 agent.session.id 取");
check(agentKey({ id: "a-2" }) === "a-2", "退回到 agent.id");
check(agentKey(undefined) === "", "取不到 ⇒ 空串（护栏就不掐）");

console.log(`\n失败 ${fail}`);
console.log(fail === 0 ? "ORPHAN-GUARD GREEN" : "ORPHAN-GUARD RED");
process.exit(fail === 0 ? 0 : 1);
