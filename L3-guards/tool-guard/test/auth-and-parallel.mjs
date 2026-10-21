// 授权闸 + 并行闸：重启类动作必须有本轮用户消息授权；已有活窗口时禁止再起 detached 重活。
import { restartGate, parallelGate, isRestartAuthorized, latestUserText, liveWindow } from "../index.js";
import { writeFileSync, rmSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

let fail = 0;
const check = (c, m, e = "") => { if (c) console.log(`  ✓ ${m}`); else { fail += 1; console.log(`  ✗ ${m}${e ? "  " + e : ""}`); } };

console.log("=== 取本轮用户消息 ===");
check(latestUserText([{ role: "user", content: "第一句" }, { role: "assistant", content: "x" }, { role: "user", content: "继续" }]) === "继续",
  "取最后一条 user");
check(latestUserText([{ role: "user", content: [{ type: "text", text: "分段" }, { type: "text", text: "内容" }] }]) === "分段 内容",
  "数组式内容也能拼");
check(latestUserText([]) === "", "空数组 ⇒ 空串");
check(latestUserText([{ role: "assistant", content: "只有助手" }]) === "", "没有 user ⇒ 空串");

console.log("=== 授权判定（否定句优先）===");
check(isRestartAuthorized("重启") === true, "「重启」⇒ 授权");
check(isRestartAuthorized("可以重启宿主了") === true, "「可以重启宿主了」⇒ 授权");
check(isRestartAuthorized("不要重启") === false, "「不要重启」⇒ 不授权");
check(isRestartAuthorized("先别停服务") === false, "「先别停服务」⇒ 不授权");
check(isRestartAuthorized("继续，看看测试结果拿到了吗") === false, "「继续」⇒ 不授权（正是这次的案例）");
check(isRestartAuthorized("") === false, "空消息 ⇒ 不授权");

console.log("=== 重启闸 ===");
const cmd = 'systemd-run --user --on-active=40 --unit=x systemctl --user restart dsh-web.service';
const blocked = restartGate({ cmd, userText: "继续，看看测试结果拿到了吗" });
check(typeof blocked === "string" && blocked.includes("需要用户授权"), "没有授权的重启 ⇒ 拒");
check(typeof blocked === "string" && blocked.includes("继续，看看测试结果拿到了吗"), "拒绝理由里逐字回显本轮用户消息");
check(restartGate({ cmd, userText: "重启宿主" }) === undefined, "本轮说了「重启」⇒ 放行");
check(restartGate({ cmd: "ls -la", userText: "继续" }) === undefined, "非重启命令 ⇒ 不受影响");
check(restartGate({ cmd: "kill -TERM 12345", userText: "继续" }) === undefined, "杀普通 pid 不归这道闸（由别的判据管）");
check(typeof restartGate({ cmd: "kill -TERM $(pgrep -f llama-swap)", userText: "继续" }) === "string", "杀 llama-swap ⇒ 需要授权");
check(restartGate({ cmd, userText: "继续", enabled: false }) === undefined, "开关关掉 ⇒ 不拦");

console.log("=== 并行闸 ===");
const win = { pid: 4242, label: "windowB2a", at: Date.now() };
check(typeof parallelGate({ cmd: "setsid bash windowB2a.sh > x.log 2>&1 &", window: win }) === "string", "有活窗口时再起 detached ⇒ 拒");
check(parallelGate({ cmd: "setsid bash windowB2a.sh &", window: null }) === undefined, "没有窗口 ⇒ 放行");
check(parallelGate({ cmd: "ls -la", window: win }) === undefined, "非 detached 命令 ⇒ 放行");
check(parallelGate({ cmd: "nohup bash big.sh &", window: win }) !== undefined, "nohup 也算 detached");

console.log("=== 窗口锁存活判定 ===");
const dir = join(tmpdir(), `winlock-${process.pid}`);
mkdirSync(dir, { recursive: true });
const lf = join(dir, "window.lock");
writeFileSync(lf, JSON.stringify({ pid: process.pid, label: "self", at: Date.now() }));
check(liveWindow(lf)?.pid === process.pid, "自己的 pid ⇒ 活着");
writeFileSync(lf, JSON.stringify({ pid: 999999, label: "dead", at: Date.now() }));
check(liveWindow(lf) === null, "死 pid ⇒ 视为陈旧");
rmSync(lf);
check(liveWindow(lf) === null, "锁文件不存在 ⇒ null");
rmSync(dir, { recursive: true, force: true });

console.log(`\n失败 ${fail}`);
console.log(fail === 0 ? "AUTH-PARALLEL GREEN" : "AUTH-PARALLEL RED");
process.exit(fail === 0 ? 0 : 1);
