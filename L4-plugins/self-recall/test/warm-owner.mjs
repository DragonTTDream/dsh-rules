// 预热的单一所有者：脚本 EXIT trap 与工具侧不能各发一次。
// 病根（2026-10-22 实测）：脚本里 `( … ) &` 后台预热，工具看到 marker 时那行 self-recall-warm= 还没写出来，
// 于是工具又发一个预热请求；两个请求抢同一个装载，第二个被 provider 拒 ⇒ warmOk:false / warmMs:0，
// 而内存确实被第一个装回来了（memAfterMB 53 GB）——用户看到的就是「回来没预热」。
import { decideWarm } from "../index.js";

let fail = 0;
const check = (c, m, e = "") => { if (c) console.log(`  ✓ ${m}`); else { fail += 1; console.log(`  ✗ ${m}${e ? "  " + e : ""}`); } };

console.log("=== 脚本已给结论就直接采信 ===");
const a = decideWarm({ scriptWarmCode: "200" });
check(a.by === "script" && a.ok === true, "脚本 warm=200 ⇒ 归 script，不重复发请求");
const b = decideWarm({ scriptWarmCode: "200", alreadyLoaded: true });
check(b.by === "script", "两者都成立时优先归 script（更早的证据）");

console.log("=== 已经装载就不要再打一次（幂等）===");
const c = decideWarm({ alreadyLoaded: true });
check(c.by === "already-loaded" && c.ok === true, "已装载 ⇒ 归 already-loaded");

console.log("=== 都没有才自己发 ===");
const d = decideWarm({});
check(d.by === "self" && d.ok === false, "无结论且未装载 ⇒ self（由调用方真发请求并回填结果）");
const e = decideWarm({ scriptWarmCode: "500" });
check(e.by === "self", "脚本预热失败（非 200）⇒ 仍由自己补一次");

console.log("=== 默认值不炸 ===");
check(decideWarm().by === "self", "空输入 ⇒ self");

console.log(`\n失败 ${fail}`);
console.log(fail === 0 ? "WARM-OWNER GREEN" : "WARM-OWNER RED");
process.exit(fail === 0 ? 0 : 1);
