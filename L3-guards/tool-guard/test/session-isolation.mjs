// 会话隔离：A 会话的授权/事实绝不能给 B 会话用。
// 2026-10-22 实测事故：两个插件把状态存在模块级单槽 ⇒ 隔壁会话读到了这边会话的「最新用户消息」。
import { apply, noteUserText } from "../index.js";

let fail = 0;
const check = (c, m, e = "") => { if (c) console.log(`  ✓ ${m}`); else { fail += 1; console.log(`  ✗ ${m}${e ? "  " + e : ""}`); } };

let guard = null;
apply(
  { tools: { guard: (fn) => { guard = fn; return () => {}; }, register: () => () => {} }, effect: () => {}, on: () => () => {}, get: () => undefined, logger: { info: () => {} } },
  { logFile: `/tmp/iso-${process.pid}.log`, requireSnapshot: false, hostServices: [] },
);

const A = { id: "session-A" };
const B = { id: "session-B" };
const restart = { name: "bash", arguments: { command: "systemctl --user restart dsh-web.service" } };

console.log("=== 授权按会话隔离 ===");
noteUserText(A, "重启吧");
check(guard({ ...restart, agent: A }) === undefined, "A 会话说了「重启」⇒ A 的重启放行");
const b = guard({ ...restart, agent: B });
check(typeof b === "string" && b.includes("需要用户授权"), "B 会话没授权 ⇒ B 的重启被拒");
check(typeof b === "string" && !b.includes("重启吧"), "拒绝理由里不能出现 A 会话的原话");

console.log("=== B 自己授权后才放行 ===");
noteUserText(B, "重启");
check(guard({ ...restart, agent: B }) === undefined, "B 会话自己说过「重启」⇒ 放行");
check(guard({ ...restart, agent: A }) === undefined, "A 的授权仍在（互不覆盖）");

console.log("=== 否定句只影响自己那侧 ===");
noteUserText(B, "不要重启");
check(typeof guard({ ...restart, agent: B }) === "string", "B 说「不要重启」⇒ B 被拒");
check(guard({ ...restart, agent: A }) === undefined, "A 不受 B 的否定句影响");

console.log("=== 没有 agent 时走退路（不是静默放行）===");
const noAgent = guard({ ...restart });
check(noAgent === undefined || typeof noAgent === "string", "缺 agent 不抛异常");

console.log(`\n失败 ${fail}`);
console.log(fail === 0 ? "GUARD-SESSION-ISO GREEN" : "GUARD-SESSION-ISO RED");
process.exit(fail === 0 ? 0 : 1);
