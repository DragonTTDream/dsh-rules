// 自动快照：写入宿主消费集时，小文件当场拍一张再放行，而不是拒掉让人再跑一次 snap.sh。
// 依据：97 次闸门拒绝里 52 次的目标是文件（最大 36 KB）。
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { apply } from "../index.js";

// 每次跑用独立目录：用例会建快照，复用目录会让"关"的分支命中上次的残留
const ROOT = `/tmp/autosnap-test-${process.pid}-${Date.now()}`;
const SLOT = `${ROOT}/slot`;
const TARGET_DIR = `${ROOT}/profiles`;
const FILE = `${TARGET_DIR}/cfg.yml`;
mkdirSync(SLOT, { recursive: true });
mkdirSync(TARGET_DIR, { recursive: true });
writeFileSync(FILE, "before\n");

const build = (cfg) => {
  let guard = null;
  apply(
    { tools: { guard: (fn) => { guard = fn; return () => {}; } }, effect: () => {}, logger: { info: () => {} } },
    {
      logFile: `${ROOT}/guard.log`,
      requireSnapshot: true,
      snapshotSlot: SLOT,
      snapshotTargets: [TARGET_DIR],
      snapshotExempt: [`${ROOT}/slot`],
      hostServices: [],
      ...cfg,
    },
  );
  return guard;
};
const mirror = (p) => p.replace(/^\//, "").replace(/\//g, "__");

let fail = 0;
const check = (cond, msg) => { if (cond) console.log(`  ✓ ${msg}`); else { fail += 1; console.log(`  ✗ ${msg}`); } };

console.log("=== 自动快照关（默认）===");
{
  const g = build({});
  const r = g({ name: "write", arguments: { file_path: FILE } });
  check(typeof r === "string" && r.includes("没有快照"), "文件写入被拒，且理由是缺快照");
  check(!existsSync(`${SLOT}/${mirror(FILE)}`), "没有偷偷拍快照");
}

console.log("=== 自动快照开 ===");
{
  const g = build({ autoSnapshot: true });
  const r = g({ name: "write", arguments: { file_path: FILE } });
  check(r === undefined, "文件写入被放行");
  check(existsSync(`${SLOT}/${mirror(FILE)}`), "快照已落在单槽位里");
}

console.log("=== 边界：不是文件就不自动拍 ===");
{
  const g = build({ autoSnapshot: true });
  const r = g({ name: "bash", arguments: { command: `echo x > ${TARGET_DIR}/new.yml` } });
  check(typeof r === "string", "目标不存在 ⇒ 仍然拒绝（拍不出快照就是没有退路）");
  const r2 = g({ name: "bash", arguments: { command: `echo x > ${TARGET_DIR}` } });
  check(typeof r2 === "string", "目标是目录 ⇒ 仍然拒绝（只有小文件才自动拍）");
}

console.log("=== 已有快照时不再重复拍 ===");
{
  const g = build({ autoSnapshot: true });
  const before = `${SLOT}/${mirror(FILE)}`;
  check(existsSync(before), "上一次拍的快照还在");
  const r = g({ name: "write", arguments: { file_path: FILE } });
  check(r === undefined, "有快照直接放行");
}

console.log(`\n失败 ${fail}`);
console.log(fail === 0 ? "AUTOSNAP GREEN" : "AUTOSNAP RED");
process.exit(fail === 0 ? 0 : 1);
