// FM-1.5 停滞闸（借 MAST 的 14 个失败模式：「不知道何时该停」）
// 同一文件连续写出相同内容 = 空转；写了等于没写。
import { apply, contentHash, stallGate } from "../index.js";

let fail = 0;
const check = (c, m, e = "") => { if (c) console.log(`  ✓ ${m}`); else { fail += 1; console.log(`  ✗ ${m}${e ? "  " + e : ""}`); } };

console.log("=== 哈希稳定 ===");
check(contentHash("abc") === contentHash("abc"), "同内容同哈希");
check(contentHash("abc") !== contentHash("abd"), "不同内容不同哈希");

console.log("=== stallGate 纯函数 ===");
const h = (c) => ({ target: "/f", hash: contentHash(c) });
check(stallGate({ target: "/f", content: "A", history: [] }) === undefined, "无历史 ⇒ 放行");
check(stallGate({ target: "/f", content: "A", history: [h("A"), h("A")] }) === "string".replace("string", "x") || typeof stallGate({ target: "/f", content: "A", history: [h("A"), h("A")] }) === "string", "连续两次写同内容 ⇒ 第 3 次拦");
check(stallGate({ target: "/f", content: "B", history: [h("A"), h("A")] }) === undefined, "内容变了 ⇒ 放行");
check(stallGate({ target: "/g", content: "A", history: [h("A"), h("A")] }) === undefined, "不同目标互不影响");
check(stallGate({ target: "/f", content: "A", history: [h("A"), h("A")], enabled: false }) === undefined, "开关关 ⇒ 不拦");

console.log("=== 接入守卫 ===");
{
  let g = null;
  apply(
    { tools: { guard: (fn) => { g = fn; return () => {}; }, register: () => () => {} }, effect: () => {}, on: () => () => {}, get: () => undefined, logger: { info: () => {} } },
    { logFile: `/tmp/st-${process.pid}.log`, requireSnapshot: false, hostServices: [],
      requireTodoEveryMutations: 0, requireTodoEveryMinutes: 0, repeatDenyAt: 0,
      planFile: "/tmp/none-stall.md", stallAt: 3 },
  );
  const w = (content) => g({ name: "write", arguments: { file_path: "/tmp/target.txt", content }, agent: { id: "s1" } });
  check(w("A") === undefined, "第 1 次写 A 放行");
  check(w("A") === undefined, "第 2 次写 A 放行");
  const third = w("A");
  check(typeof third === "string" && third.includes("停滞"), "第 3 次写 A 被拦（空转）", String(third).slice(0, 40));
  check(w("B") === undefined, "内容改成 B 放行");
}

console.log("=== 负样本：stallAt=0 ⇒ 永远不拦 ===");
{
  let g = null;
  apply(
    { tools: { guard: (fn) => { g = fn; return () => {}; }, register: () => () => {} }, effect: () => {}, on: () => () => {}, get: () => undefined, logger: { info: () => {} } },
    { logFile: `/tmp/st0-${process.pid}.log`, requireSnapshot: false, hostServices: [],
      requireTodoEveryMutations: 0, requireTodoEveryMinutes: 0, repeatDenyAt: 0,
      planFile: "/tmp/none-stall0.md", stallAt: 0 },
  );
  let blocked = 0;
  for (let i = 0; i < 6; i += 1) {
    if (typeof g({ name: "write", arguments: { file_path: "/tmp/t2.txt", content: "SAME" }, agent: { id: "s1" } }) === "string") blocked += 1;
  }
  check(blocked === 0, "stallAt=0 ⇒ 写 6 次同内容不拦");
}

console.log(`\n失败 ${fail}`);
console.log(fail === 0 ? "STALL-GATE GREEN" : "STALL-GATE RED");
process.exit(fail === 0 ? 0 : 1);
