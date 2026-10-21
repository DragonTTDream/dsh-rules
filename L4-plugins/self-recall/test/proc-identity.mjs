// 进程身份：按「谁」终止，而不是按「像什么」搜索。
// 依据：capability-based security（身份由创建时发放）+ systemd KillMode=control-group（按组终止）。
import { apply, ownerOf, procInfo, selfChain, readJobs, windowLockSnippet } from "../index.js";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { tmpdir } from "node:os";

let fail = 0;
const check = (c, m, e = "") => { if (c) console.log(`  ✓ ${m}`); else { fail += 1; console.log(`  ✗ ${m}${e ? "  " + e : ""}`); } };

console.log("=== 归属判定（纯函数）===");
const jobs = [{ jobId: "win-1", pgid: 4242 }];
check(ownerOf({ pid: 1, pgid: 1, cmd: "x" }, { selfPids: new Set([1]), jobs }) === "self", "自己 ⇒ self");
check(ownerOf({ pid: 2, pgid: 2, cmd: "/usr/bin/llama-swap -config x" }, { selfPids: new Set(), jobs }) === "protected", "llama-swap ⇒ protected");
check(ownerOf({ pid: 3, pgid: 3, cmd: "python3 serve/server.py --engine strata" }, { selfPids: new Set(), jobs }) === "protected", "引擎 ⇒ protected");
check(ownerOf({ pid: 4, pgid: 4242, cmd: "bash windowB" }, { selfPids: new Set(), jobs }) === "mine:win-1", "作业组 ⇒ mine:<jobId>");
check(ownerOf({ pid: 5, pgid: 99, cmd: "bash other" }, { selfPids: new Set(), jobs }) === "foreign", "其它 ⇒ foreign");

console.log("=== /proc 读取 ===");
const me = procInfo(process.pid);
check(me.alive === true, "能读到自己的 stat");
check(Number.isInteger(me.pgid) && me.pgid > 0, "pgid 是正整数", String(me.pgid));
check(selfChain().has(process.pid), "自己的 pid 在 selfChain 里（永不可杀）");

console.log("=== 作业记录 ===");
const work = mkdtempSync(join(tmpdir(), "proc-id-"));
const jobDir = join(work, "jobs");
mkdirSync(jobDir, { recursive: true });
writeFileSync(join(jobDir, "j1.json"), JSON.stringify({ jobId: "j1", pid: process.pid, pgid: me.pgid, label: "x", at: Date.now() }));
const parsed = await readJobs({ jobDir });
check(parsed.length === 1 && parsed[0].jobId === "j1", "读回作业记录");

console.log("=== 生成的脚本头会写 pid/pgid ===");
const snip = windowLockSnippet({ lockPath: join(work, "w.lock"), jobDir }, "demo", "demo-1");
check(snip.includes("SR_PGID=") && snip.includes("demo-1.json"), "含 pgid 采集与作业文件名");

console.log("=== proc_kill 拒绝杀自己 ===");
let tools = {};
apply(
  {
    tools: { guard: () => () => {}, register: (t) => { tools[t.name] = t; return () => {}; } },
    effect: () => {}, on: () => () => {}, get: () => undefined, set: () => {}, logger: { info: () => {}, warn: () => {} },
  },
  { endpoint: "http://127.0.0.1:1", model: "none", localModels: [], warmAfterRun: false,
    singleWindow: true, lockPath: join(work, "w.lock"), ledgerPath: join(work, "a.jsonl"), jobDir, logFile: join(work, "log") },
);
check(!!tools.proc_kill && !!tools.proc_list, "proc_list / proc_kill 已注册");
const r1 = await tools.proc_kill.execute({ pids: [process.pid] });
check(r1.ok === false && r1.refused.some((x) => x.includes("调用链")), "杀自己 ⇒ 拒绝", JSON.stringify(r1.refused));
const r2 = await tools.proc_kill.execute({ jobId: "unknown" });
check(r2.ok === false, "未知 jobId ⇒ 拒绝");

const list = await tools.proc_list.execute({ limit: 5 });
check(Array.isArray(list.rows) && list.rows.length > 0, "proc_list 能列出进程");
check(list.rows.every((r) => !r.includes(`pid=${process.pid} `)), "proc_list 默认为剔除自己");
check(list.rows.every((r) => r.includes("归属=")), "每行都带归属");

rmSync(work, { recursive: true, force: true });

console.log(`\n失败 ${fail}`);
console.log(fail === 0 ? "PROC-IDENTITY GREEN" : "PROC-IDENTITY RED");
process.exit(fail === 0 ? 0 : 1);
