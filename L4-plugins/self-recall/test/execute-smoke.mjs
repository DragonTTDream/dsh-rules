// execute() 冒烟：真跑一次窗口，捕获「治理逻辑用到未绑定变量」这类只有执行才暴露的错。
// 起因（2026-10-22）：加重跑治理时 execute 的解构没绑 change，node --check 只验语法，
// 单测又只测纯函数 decideRerun ⇒ 真跑必抛 ReferenceError，三次窗口全卡在提交阶段。
import { apply } from "../index.js";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

let fail = 0;
const check = (c, m, e = "") => { if (c) console.log(`  ✓ ${m}`); else { fail += 1; console.log(`  ✗ ${m}${e ? "  " + e : ""}`); } };

const work = mkdtempSync(join(tmpdir(), "facts-smoke-"));   // 每次独立：台账/锁不留跨轮状态
let tools = {};
const ctx = {
  tools: { guard: () => () => {}, register: (t) => { tools[t.name] = t; return () => {}; } },
  effect: () => {},
  on: () => () => {},
  get: () => undefined,
  set: () => {},
  logger: { info: () => {}, warn: () => {} },
};

apply(ctx, {
  endpoint: "http://127.0.0.1:1",     // 不可达也行：unload=false 时不依赖它
  model: "none",
  localModels: [],
  warmAfterRun: false,
  singleWindow: true,
  lockPath: join(work, "window.lock"),
  ledgerPath: join(work, "attempts.jsonl"),
  logFile: join(work, "self-recall.log"),
});

check(!!tools.arbitrate_run, "arbitrate_run 已注册");

try {
  const r = await tools.arbitrate_run.execute({
    script: "echo hi; echo marker=ok",
    label: "smoke",
    timeoutSec: 60,
    unload: false,
    warm: false,
  });
  check(r.marker === "ok", "窗口跑通并取到 marker", JSON.stringify(r.marker));
  check(r.reason === "marker", "reason=marker", String(r.reason));
  check(typeof r.capSec === "number" && r.capSec <= 900, "capSec 被压到 ≤900", String(r.capSec));
  check(r.attempt === 1, "首次尝试 attempt=1", String(r.attempt));
  check(r.rerunDenied === false, "首次不被重跑治理拦", String(r.rerunDenied));
} catch (e) {
  fail += 1;
  console.log(`  ✗ execute 抛出异常：${e && e.message}`);
}

console.log(`\n失败 ${fail}`);
rmSync(work, { recursive: true, force: true });
console.log(fail === 0 ? "EXECUTE-SMOKE GREEN" : "EXECUTE-SMOKE RED");
process.exit(fail === 0 ? 0 : 1);
