// 参数契约：schema 声明的参数 ≡ execute 解构出来的参数。
// 起因（2026-10-22）：加 change 时只改了 schema 与函数体，漏了解构 ⇒ ReferenceError，三次窗口全废。
// 依据：Parse-Don't-Validate（边界处把输入解析成有类型的值）+ ESLint no-undef（未声明标识符必须静态可见）。
// 这里用无依赖的源码对拍，等价于对「参数表」这一条边界做静态检查。
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const src = readFileSync(join(here, "..", "index.js"), "utf8");

let fail = 0;
const check = (c, m, e = "") => { if (c) console.log(`  ✓ ${m}`); else { fail += 1; console.log(`  ✗ ${m}${e ? "  " + e : ""}`); } };

// 切出每个工具块：从 name: "x" 到下一个 name: "y" 之前
const blocks = [];
const re = /name: "([a-z_]+)",/g;
let m;
while ((m = re.exec(src)) !== null) blocks.push({ name: m[1], start: m.index });
blocks.forEach((b, i) => { b.end = i + 1 < blocks.length ? blocks[i + 1].start : src.length; });

for (const b of blocks) {
  const body = src.slice(b.start, b.end);
  const pStart = body.indexOf("parameters:");
  if (pStart === -1) { check(false, `${b.name} 有 parameters 段`); continue; }
  const pSeg = body.slice(pStart, body.indexOf("output:", pStart) === -1 ? body.length : body.indexOf("output:", pStart));
  const schemaKeys = [...pSeg.matchAll(/^\s{6,}([a-zA-Z_]\w*): \{ type:/gm)].map((x) => x[1]).sort();

  const ex = body.match(/async execute\(\{([^}]*)\}/);
  if (!ex) { check(schemaKeys.length === 0, `${b.name} 无参（schema 应为空）`, `schema=${schemaKeys}`); continue; }
  const destructured = ex[1].split(",").map((s) => s.trim().split(":")[0].trim()).filter(Boolean).sort();

  const missingInHandler = schemaKeys.filter((k) => !destructured.includes(k));
  const extraInHandler = destructured.filter((k) => !schemaKeys.includes(k));

  check(missingInHandler.length === 0, `${b.name}: schema 的每个参数都被解构`, `缺 ${missingInHandler.join(",")}`);
  check(extraInHandler.length === 0, `${b.name}: 解构的参数都在 schema 里`, `多 ${extraInHandler.join(",")}`);
  if (schemaKeys.length) console.log(`      ${b.name}: schema=[${schemaKeys.join(", ")}] handler=[${destructured.join(", ")}]`);
}

// ── 第二类漂移：Config 的键没进 cfg 白名单解析器（2026-10-22 实测踩过：
//    新加 7 个键只改了 schema 与 DEFAULTS，cfg = {…} 逐键构造却漏了它们 ⇒ 配置覆盖被静默忽略）──
const cfgBlkSrc = src.slice(src.indexOf("export const Config = z.object({"));
const cfgSchemaKeys = [...cfgBlkSrc.slice(0, cfgBlkSrc.indexOf("\n});")).matchAll(/^\s{2}([a-zA-Z_]\w*):/gm)].map((x) => x[1]);
const builderSrc = src.slice(src.indexOf("  const cfg = {"));
const builderKeys = [...builderSrc.slice(0, builderSrc.indexOf("\n  };")).matchAll(/^\s{4}([a-zA-Z_]\w*):/gm)].map((x) => x[1]);
const directRead = new Set([...src.matchAll(/config\.([a-zA-Z_]\w*)/g)].map((x) => x[1]));
const unwired = cfgSchemaKeys.filter((k) => !builderKeys.includes(k) && !directRead.has(k));
check(cfgSchemaKeys.length > 10, `Config 键提取正常（${cfgSchemaKeys.length} 个）`);
check(unwired.length === 0, "Config 的每个键都进了 cfg 解析器或被直接读取", `未接线：${unwired.join(",")}`);
if (unwired.length) console.log(`      未接线：${unwired.join(", ")}`);

// 反向对照：人为制造漂移必须被抓到
const fake = [
  'name: "demo",',
  "      parameters: {",
  '        a: { type: "string" },',
  '        b: { type: "number" },',
  "      },",
  "      async execute({ a }) { a; },",
].join("\n");
const pSeg = fake.slice(fake.indexOf("parameters:"));
const sKeys = [...pSeg.matchAll(/^\s{6,}([a-zA-Z_]\w*): \{ type:/gm)].map((x) => x[1]);
const dKeys = fake.match(/async execute\(\{([^}]*)\}/)[1].split(",").map((s) => s.trim());
check(sKeys.length === 2 && dKeys.length === 1, "对拍逻辑本身能识别「schema 2 个、handler 1 个」的漂移", `s=${sKeys.length} d=${dKeys.length}`);

console.log(`\n失败 ${fail}`);
console.log(fail === 0 ? "PARAM-CONTRACT GREEN" : "PARAM-CONTRACT RED");
process.exit(fail === 0 ? 0 : 1);
