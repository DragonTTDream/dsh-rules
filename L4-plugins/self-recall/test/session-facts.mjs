// 会话事实：harness 侧的逐字真值（替代"让模型凭记忆复述"）。
import { sessionFactFrom, apply } from "../index.js";

let fail = 0;
const check = (c, m, e = "") => { if (c) console.log(`  ✓ ${m}`); else { fail += 1; console.log(`  ✗ ${m}${e ? "  " + e : ""}`); } };

console.log("=== 抽取：取最后一条 user 消息 ===");
const f1 = sessionFactFrom([
  { role: "user", content: "批准" },
  { role: "assistant", content: "好" },
  { role: "user", content: "继续，看看测试结果拿到了吗" },
], 1700000000000, 7);
check(f1 && f1.text === "继续，看看测试结果拿到了吗", "取最后一条 user");
check(f1 && f1.turn === 7, "带上回合号");

console.log("=== 数组式内容与空白 ===");
const f2 = sessionFactFrom([
  { role: "user", content: [{ type: "text", text: "分段" }, { type: "text", text: "内容" }] },
], 1, 1);
check(f2 && f2.text === "分段 内容", "数组式内容拼接");
check(sessionFactFrom([{ role: "user", content: "   " }]) === null, "只有空白 ⇒ null");
check(sessionFactFrom([]) === null, "空数组 ⇒ null");
check(sessionFactFrom([{ role: "assistant", content: "x" }]) === null, "没有 user ⇒ null");
check(sessionFactFrom(undefined) === null, "undefined 不炸");

console.log("=== 超长截断（防止把整段日志塞进上下文）===");
const long = sessionFactFrom([{ role: "user", content: "字".repeat(5000) }]);
check(long.text.length === 2000, "截到 2000 字");

console.log("=== 工具注册与返回形状 ===");
let registered = null;
apply(
  {
    tools: {
      guard: () => () => {},
      register: (t) => { if (t?.name === "session_facts") registered = t; return () => {}; },
    },
    effect: () => {},
    logger: { info: () => {}, warn: () => {} },
    on: () => () => {},
    get: () => undefined,
    set: () => {},
  },
  { logFile: `/tmp/facts-${process.pid}.log` },
);
check(!!registered, "session_facts 已注册");
if (registered) {
  const r = await registered.execute({});
  check(r.known === false, "尚未捕获 ⇒ known=false");
  check(typeof r.note === "string" && r.note.length > 0, "并说明原因");
}

console.log(`\n失败 ${fail}`);
console.log(fail === 0 ? "SESSION-FACTS GREEN" : "SESSION-FACTS RED");
process.exit(fail === 0 ? 0 : 1);
