// 路由隔离（self-recall 侧）：系统提示词里那句「本会话模型是 X」只能来自本会话的路由。
// 2026-10-22 实测串台：lastRoute 是进程级单槽 ⇒ A 会话切模型后，B 会话的提示词写成 A 的模型名
// （本轮真实观察到同一会话里模型名在 -text / -256k 之间跳变）。
import { apply } from "../index.js";

let fail = 0;
const check = (c, m, e = "") => { if (c) console.log(`  ✓ ${m}`); else { fail += 1; console.log(`  ✗ ${m}${e ? "  " + e : ""}`); } };

let section = null;
let onRequest = null;
apply(
  {
    tools: { guard: () => () => {}, register: () => () => {} },
    effect: () => {},
    on: (ev, fn) => { if (ev === "agent/request") onRequest = fn; return () => {}; },
    get: (name) => (name === "systemPrompt" ? { section: (d) => { section = d; } } : undefined),
    set: () => {},
    logger: { info: () => {}, warn: () => {} },
  },
  {
    endpoint: "http://127.0.0.1:1",
    model: "m-default",
    localModels: ["m-a", "m-b"],
    memFloorMB: 4096,
    freeRunMB: 8192,
    modelGB: 48,
    warmAfterRun: false,
    logFile: `/tmp/route-${process.pid}.log`,
  },
);

check(typeof section?.text === "function", "系统提示词段落已注册");
check(typeof onRequest === "function", "agent/request 监听已注册");

const A = { id: "session-A" };
const B = { id: "session-B" };
const C = { id: "session-C" };

await onRequest({ agent: A }, async () => ({ provider: "p", model: "m-a" }));
await onRequest({ agent: B }, async () => ({ provider: "p", model: "m-b" }));

const ta = section.text({ agent: A });
const tb = section.text({ agent: B });
const tc = section.text({ agent: C });

console.log("=== A 只看到自己的模型 ===");
check(ta.includes("m-a"), "A 的提示词里是 m-a");
check(!ta.includes("m-b"), "A 的提示词里没有 B 的 m-b");
console.log("=== B 只看到自己的模型 ===");
check(tb.includes("m-b"), "B 的提示词里是 m-b");
check(!tb.includes("m-a"), "B 的提示词里没有 A 的 m-a（旧实现这里会串）");
console.log("=== 没记录路由的会话不吃别人的 ===");
check(!tc.includes("m-a") && !tc.includes("m-b"), "陌生会话回落 config.model，不显示别人的模型");
check(tc.includes("m-default"), "陌生会话显示默认模型");

console.log(`\n失败 ${fail}`);
console.log(fail === 0 ? "ROUTE-ISO GREEN" : "ROUTE-ISO RED");
process.exit(fail === 0 ? 0 : 1);
