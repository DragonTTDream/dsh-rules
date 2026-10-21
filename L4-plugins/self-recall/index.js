/**
 * dsh-self-recall — 会话自召回 + 串行资源仲裁（技能随插件分发）
 *
 * 1) 保活：监听 agent/request-error，模型请求失败后按退避无上限重试，
 *    保证回合不因模型离线被标为永久失败。对 provider 零知识。
 * 2) 工具：把"卸载 → 后台跑 → 等 marker → 返回"整套纪律做成一个工具，
 *    模型不需要"学会"这套机制，调用即可，结构上就不可能把回合干净结束掉。
 * 3) 技能：装载时把 SKILL.md 写入 ~/.dsh/skills（缺失才写，不覆盖用户版本）。
 */

import { defineTool } from "@deepseek-ai/dsh-tools";
import z from "@deepseek-ai/schemastery";
import { mkdir, writeFile, access, unlink, readFile, appendFile, readdir } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { dirname } from "node:path";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

export const name = "self-recall";
export const inject = ["tools"];

// 官方写法：export const Config = z.object({...})。加载器按它校验 patch 里的 config
// （cordis/lib/types/registry.d.ts:116 "validated against its Config schema"）。
// 全部键可选：缺哪个由下方 DEFAULTS 兜，代码行为不变；写错键名/类型当场报。
export const Config = z.object({
  endpoint: z.string(),
  model: z.string(),
  statusPath: z.string(),
  unloadPath: z.string(),
  initialDelayMs: z.number().min(0).step(1),
  maxDelayMs: z.number().min(0).step(1),
  resetAfterMs: z.number().min(0).step(1),
  maxAttempts: z.number().min(0).step(1),
  jitterRatio: z.number().min(0).max(1),
  memFloorMB: z.number().min(0).step(1),
  freeRunMB: z.number().min(0).step(1),
  modelGB: z.number().min(0).step(1),
  warmAfterRun: z.boolean(),
  pendingWarm: z.boolean(),
  warmSelfScript: z.boolean(),
  warmOnlyLocalSession: z.boolean(),
  pendingScanMs: z.number().min(5000).step(1000),
  failFastSec: z.number().min(0).step(1),
  stallMinutes: z.number().min(0).step(1),
  attemptBudget: z.number().min(0).step(1),
  circuitAfter: z.number().min(0).step(1),
  ledgerPath: z.string(),
  singleWindow: z.boolean(),
  lockPath: z.string(),
  jobDir: z.string(),
  shipSkill: z.boolean(),
  auxModels: z.array(z.string()),
  localModels: z.array(z.string()),
});

const DEFAULTS = {
  initialDelayMs: 5000,
  maxDelayMs: 30000,
  jitterRatio: 0.2,
  maxAttempts: 0,
  resetAfterMs: 300000,
  endpoint: "http://127.0.0.1:1234",
  model: "",
  unloadPath: "/api/models/unload",
  statusPath: "/v1/models",
  memFloorMB: 4096,
  freeRunMB: 8192,
  modelGB: 48,
  warmAfterRun: true,
  pendingWarm: true,
  warmSelfScript: true,
  warmOnlyLocalSession: true,
  pendingScanMs: 20000,
  failFastSec: 8,      // 进程没了且无 marker ⇒ 8 秒判失败（下限 3）
  stallMinutes: 10,
  // 重跑治理（2026-10-22，替代"硬拒同一脚本"）：按失败类型决定能不能重跑，
  // 而不是按"脚本有没有变"硬拦。依据 Temporal 的 transient/intermittent/permanent 三分
  // + Google SRE 的尝试预算 + Reflexion 的"重试要带自我批判"。
  attemptBudget: 2,      // 同一脚本（intermittent 类）最多尝试次数，0 = 不限
  circuitAfter: 3,       // 连续 N 次同因失败 ⇒ 熔断，要求换方法
  ledgerPath: "~/.dsh/arbitrate/attempts.jsonl",
  // 单窗口锁（2026-10-22 用户令）：本机只有一条推理序列，并行第二个重活窗口只会互相抢资源。
  // 锁由任务脚本自己写（pid = $$），进程死了即视为陈旧，不靠 trap 清理（脚本可能自带 trap）。
  singleWindow: true,
  lockPath: "~/.dsh/arbitrate/window.lock",
  // 作业身份（capability）：任务脚本自己写 pid/pgid，之后按「组」终止，不按模式搜索。
  jobDir: "~/.dsh/arbitrate/jobs",   // 日志静默 N 分钟判空转（0 = 关）
  auxModels: [],
  localModels: [],
};

function num(v, fb, min) { const n = Number(v); return Number.isFinite(n) && n >= min ? Math.floor(n) : fb; }
function str(v, fb) { return typeof v === "string" && v.length > 0 ? v : fb; }
function arr(v, fb) { return Array.isArray(v) ? v.filter((x) => typeof x === "string" && x.length > 0) : fb; }

function sleep(ms, signal) {
  if (signal?.aborted) return Promise.resolve(false);
  return new Promise((resolve) => {
    const t = setTimeout(() => { signal?.removeEventListener("abort", off); resolve(true); }, ms);
    function off() { clearTimeout(t); resolve(false); }
    signal?.addEventListener("abort", off, { once: true });
  });
}

async function memInfo() {
  const { readFileSync } = await import("node:fs");
  const m = readFileSync("/proc/meminfo", "utf8");
  const avail = +(m.match(/MemAvailable:\s+(\d+)/)?.[1] ?? 0);
  const free = +(m.match(/SwapFree:\s+(\d+)/)?.[1] ?? 0);
  return { memAvailableMB: Math.round(avail / 1024), swapFreeMB: Math.round(free / 1024) };
}

async function modelStatus(cfg) {
  try {
    const r = await fetch(`${cfg.endpoint}${cfg.statusPath}`, { signal: AbortSignal.timeout(15000) });
    const d = await r.json();
    const hit = d?.data?.find?.((x) => x?.id === cfg.model);
    return hit?.status?.value ?? hit?.status ?? "unknown";
  } catch (e) { return `error: ${e.message}`; }
}

// ── 当前会话的模型路由（2026-10-15 用户令）─────────────────────────────────────
// 预热对象绑定「本地模型 + 当前会话」：会话跑云端模型时**不预热本地模型**（否则白装 48GB 常驻）。
// agent/request 是 waterfall：拿 next() 的配置看一眼就原样返回，零副作用、零阻塞。
let lastRoute = null;
// 本地模型集合（config.localModels；为空则退回 [cfg.model]，即旧行为）。
// 2026-10-16 用户令：判据从「== cfg.model」放开成「是本地这几个条目之一」——本机主模型有纯文本 / 弹性 / 消融三条，
// 写死一条会让另一条的会话既不被卸、也不被装回（实测：会话切到 -256k 后四条回归路径全程跳过 + 卸错对象）。
function localModels(cfg) {
  const l = Array.isArray(cfg.localModels) ? cfg.localModels.filter((x) => typeof x === "string" && x.length > 0) : [];
  return l.length ? l : (cfg.model ? [cfg.model] : []);
}
// 会话当前该用哪个本地模型：命中返回该 id；会话跑的不是本地这些条目 ⇒ null（不预热本地模型）。
// 路由未知 ⇒ 保守返回 cfg.model（保持旧行为：该 warm 还 warm）。
function localTarget(cfg, recorded = null) {
  const r = recorded || lastRoute;
  if (!r || !r.model) return cfg.model;
  const hit = localModels(cfg).find((m) => r.model === m || String(r.model).endsWith(`/${m}`));
  return hit || null;
}
function routeIsLocal(cfg, recorded = null) { return localTarget(cfg, recorded) !== null; }

// 端点当前真正在跑的模型：卸载对象用它，避免"去卸一个没装载的模型"（旧实现打的是写死的 cfg.model）。
async function loadedModels(cfg) {
  try {
    const r = await fetch(`${cfg.endpoint}${cfg.statusPath}`, { signal: AbortSignal.timeout(8000) });
    const d = await r.json();
    return (d?.data || []).filter((m) => (m?.status?.value || "") === "loaded").map((m) => m.id);
  } catch { return []; }
}
// 重活窗口该卸谁：会话模型（在场时）→ 端点正在跑的本地模型 → 会话模型 → config.model（旧行为）
async function unloadTarget(cfg, recorded = null) {
  const t = localTarget(cfg, recorded);
  const loaded = await loadedModels(cfg);
  const pool = localModels(cfg);
  if (t && (loaded.length === 0 || loaded.includes(t))) return t;   // 会话模型在场（或状态读不到）⇒ 就它
  return loaded.find((m) => pool.includes(m)) || t || cfg.model;    // 否则卸真正占着内存的那个
}

async function unloadModel(cfg) {
  // 用谁卸谁（本机约束 P10：禁止全局卸载，避免连坐卸掉其它模型）
  const path = cfg.model ? `${cfg.unloadPath}/${encodeURIComponent(cfg.model)}` : cfg.unloadPath;
  try {
    const r = await fetch(`${cfg.endpoint}${path}`, { method: "POST", signal: AbortSignal.timeout(30000) });
    return { ok: r.ok, body: (await r.text()).slice(0, 120) };
  } catch (e) { return { ok: false, body: e.message }; }
}

async function warmModel(cfg) {
  try {
    const r = await fetch(`${cfg.endpoint}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: cfg.model, messages: [{ role: "user", content: "ok" }], max_tokens: 1 }),
      signal: AbortSignal.timeout(900000),
    });
    return { ok: r.ok, status: await modelStatus(cfg) };
  } catch (e) { return { ok: false, error: e.message, status: await modelStatus(cfg) }; }
}

// ── 待回归标记（R1/R2，2026-10-14 中断事故修补）──────────────────────────────
// 事故：warm 挂在工具调用的返回路径上 ⇒ 调用被中断/放弃时挂钩一起被弃 ⇒ 卸载已发生、warm 没发生，
// 会话留在离线态，只能靠用户发消息触发装载（实测 13:35:50 marker 写出 → 13:46:17 才由用户消息装载）。
// 修补：卸载成功即落盘 pending；① 超时分支补判（任务已退出就补 warm）② 回合开始前补 warm（跨中断、跨宿主重启都成立）。
// 硬约束不变：任务还在跑 ⇒ 绝不装回（串行独占不破）。
export const PENDING_PATH = join(tmpdir(), "dsh-self-recall-pending.json");
const PENDING_MAX_AGE_MS = 3 * 3600 * 1000;   // 超过 3 小时的陈旧标记直接作废，不再无限期触发装载

export async function writePending(info) {
  try { await writeFile(PENDING_PATH, JSON.stringify({ ...info, at: Date.now() }), "utf8"); return true; }
  catch { return false; }
}
export async function readPending() {
  try { return JSON.parse(await readFile(PENDING_PATH, "utf8")); } catch { return null; }
}
export async function clearPending() {
  try { await unlink(PENDING_PATH); return true; } catch { return false; }
}
// 任务是否还在跑：pgrep -f 匹配本次窗口的工作目录（目录名带时间戳，唯一）
export function jobAlive(dir) {
  if (!dir) return false;
  try { return spawnSync("pgrep", ["-f", String(dir)], { encoding: "utf8", timeout: 5000 }).status === 0; }
  catch { return false; }
}

/**
 * 轮询判定（纯函数，无 IO —— 所以能单测，不用等真实时间）。
 * 输入是一次采样 + 三个阈值，输出「继续等 / 停，reason 是什么」。
 *
 * 优先级（越靠前越可信）：marker > 进程已死 > 到 cap > 日志静默。
 * 依据（2026-10-22）：旧实现只认 marker ⇒ 脚本早失败或压根没起来都要干等到 cap。
 */

const PERMANENT_HINTS = [
  /syntax error/i, /command not found/i, /no such file/i, /cannot open/i,
  /permission denied/i, /unbound variable/i, /bad substitution/i, /cannot execute/i,
];

/** 失败三分（Temporal 口径）。判 permanent 必须有日志证据，不凭 reason 猜。 */
export function classifyFailure(reason = "", logTail = "") {
  if (reason === "no-start" || reason === "script-died") {
    return PERMANENT_HINTS.some((re) => re.test(String(logTail))) ? "permanent" : "transient";
  }
  if (reason === "stall" || reason === "timeout") return "intermittent";
  return "transient"; // marker / marker-late / 中断 / 空 → 按 transient
}

/**
 * 能不能再跑一次（纯函数，可单测）。
 *   transient    ⇒ 直接放行（宿主重启、模型卸载这类，原样重跑是对的）
 *   permanent    ⇒ 拒，并把上次的错误行还给它（重跑无意义）
 *   intermittent ⇒ 要 change（"上次为什么失败 + 这次改了什么"）+ 预算内
 */
export function decideRerun({ prev = null, change = "", attemptBudget = 2, circuitAfter = 3, sameReasonStreak = 0 } = {}) {
  if (!prev) return { action: "allow", why: "first-run", cls: "none" };
  const cls = classifyFailure(prev.reason, prev.logTailTail || "");
  if (cls === "transient") return { action: "allow", why: "transient", cls };
  if (cls === "permanent") return { action: "deny", why: "permanent", cls };
  if (Number(circuitAfter) > 0 && Number(sameReasonStreak) >= Number(circuitAfter)) {
    return { action: "deny", why: "circuit-open", cls };
  }
  if (Number(attemptBudget) > 0 && Number(prev.attempt || 1) >= Number(attemptBudget)) {
    return { action: "deny", why: "budget-exhausted", cls };
  }
  if (!String(change || "").trim()) return { action: "deny", why: "need-change", cls };
  return { action: "allow", why: "intermittent+change", cls };
}


/** 从 agent/pre-step 载荷取本轮用户消息（逐字）。返回 null = 本轮没有新用户消息。 */
export function sessionFactFrom(messages, at = Date.now(), turn = 0) {
  if (!Array.isArray(messages)) return null;
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const m = messages[i];
    if ((m && m.role) !== "user") continue;
    const c = m.content;
    const text = typeof c === "string" ? c
      : Array.isArray(c) ? c.map((x) => (typeof x === "string" ? x : (x && x.text) || "")).join(" ") : "";
    if (!String(text).trim()) continue;
    return { text: String(text).slice(0, 2000), at, turn, seq: m.id || m.seq || 0 };
  }
  return null;
}

export function pollDecision({ marker = "", alive = true, size = -1, quietSec = 0, elapsed = 0, failFast = 8, stallMin = 10, cap = 900 } = {}) {
  if (marker) return { done: true, reason: "marker" };
  const ff = Math.max(Number(failFast) || 0, 3);
  if (!alive && elapsed >= ff) return { done: true, reason: size <= 0 ? "no-start" : "script-died" };
  if (elapsed >= cap) return { done: true, reason: "timeout" };
  const sm = Number(stallMin) || 0;
  if (sm > 0 && quietSec >= sm * 60) return { done: true, reason: "stall" };
  return { done: false, reason: "" };
}


function ledgerFile(cfg) {
  const p = String(cfg.ledgerPath || "~/.dsh/arbitrate/attempts.jsonl");
  return p.startsWith("~") ? join(homedir(), p.slice(1).replace(/^\//, "")) : p;
}

async function readLedger(file) {
  try {
    const t = await readFile(file, "utf8");
    return t.split("\n").filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  } catch { return []; }
}

async function appendLedger(file, entry) {
  try { await mkdir(dirname(file), { recursive: true }); await appendFile(file, JSON.stringify(entry) + "\n", "utf8"); }
  catch { /* 台账失败不影响主流程 */ }
}


function lockFileOf(cfg) {
  const p = String(cfg.lockPath || "~/.dsh/arbitrate/window.lock");
  return p.startsWith("~") ? join(homedir(), p.slice(1).replace(/^\//, "")) : p;
}

/** 窗口锁：pid 还活着才算「有窗口在跑」。进程已死 ⇒ 陈旧，可被覆盖。 */
export function liveWindowLock(cfg) {
  try {
    const j = JSON.parse(readFileSync(lockFileOf(cfg), "utf8"));
    const pid = Number(j && j.pid);
    if (!Number.isInteger(pid) || pid <= 0) return null;
    try { process.kill(pid, 0); } catch { return null; }
    return { pid, label: String((j && j.label) || ""), at: Number((j && j.at) || 0) };
  } catch { return null; }
}

/** 写进任务脚本头部的单窗口锁（pid = 脚本自己的 $$）。 */
export function windowLockSnippet(cfg, label, jobId = "") {
  const lf = lockFileOf(cfg);
  const jd = jobDirOf(cfg);
  const safe = String(label || "").replace(/["\\]/g, "");
  const jid = String(jobId || label || "job").replace(/["\\]/g, "");
  return [
    "# self-recall: 单窗口锁 + 作业身份（pid/pgid 由脚本自己写，之后按组终止）",
    `SR_LOCK=${JSON.stringify(lf)}`,
    `SR_JOBDIR=${JSON.stringify(jd)}`,
    'SR_PGID=$(ps -o pgid= -p $$ 2>/dev/null | tr -d " ")',
    'mkdir -p "$(dirname "$SR_LOCK")" "$SR_JOBDIR" 2>/dev/null',
    `printf '{"pid":%s,"label":"${safe}","at":%s000}\\n' "$$" "$(date +%s)" > "$SR_LOCK" 2>/dev/null`,
    `printf '{"jobId":"${jid}","pid":%s,"pgid":%s,"label":"${safe}","at":%s000}\\n' "$$" "\${SR_PGID:-$$}" "$(date +%s)" > "$SR_JOBDIR/${jid}.json" 2>/dev/null`,
    "",
  ].join("\n");
}

/** 读作业记录（capability 清单）。 */
export async function readJobs(cfg) {
  const dir = jobDirOf(cfg);
  let names = [];
  try { names = await readdir(dir); } catch { return []; }
  const out = [];
  for (const f of names.filter((x) => x.endsWith(".json"))) {
    try { out.push(JSON.parse(await readFile(join(dir, f), "utf8"))); } catch { /* 坏文件跳过 */ }
  }
  return out;
}

function jobDirOf(cfg) {
  const p = String(cfg.jobDir || "~/.dsh/arbitrate/jobs");
  return p.startsWith("~") ? join(homedir(), p.slice(1).replace(/^\//, "")) : p;
}

/** 进程存活 + 读它的 pgid（/proc/<pid>/stat 第 5 列）。 */
export function procInfo(pid) {
  try {
    const st = readFileSync(`/proc/${pid}/stat`, "utf8");
    const rp = st.slice(st.lastIndexOf(")") + 2).split(" ");
    return { alive: true, pgid: Number(rp[2]), comm: String(readFileSync(`/proc/${pid}/comm`, "utf8")).trim() };
  } catch { return { alive: false, pgid: 0, comm: "" }; }
}

/** 本进程及其祖先链（永不可杀）。 */
export function selfChain() {
  const out = new Set();
  let pid = process.pid;
  for (let i = 0; i < 12 && pid > 1; i += 1) {
    out.add(pid);
    const info = procInfo(pid);
    if (!info.alive) break;
    try {
      const st = readFileSync(`/proc/${pid}/stat`, "utf8");
      const rp = st.slice(st.lastIndexOf(")") + 2).split(" ");
      pid = Number(rp[1]);
    } catch { break; }
  }
  return out;
}

const PROTECTED = /dsh-web|llama-swap|llama\.cpp|serve\/server\.py|engine\/strata/;

/** 给一个进程行打归属标签。纯函数，可单测。 */
export function ownerOf({ pid, pgid, cmd = "" }, { selfPids = new Set(), jobs = [], protectedRe = PROTECTED } = {}) {
  if (selfPids.has(pid)) return "self";
  if (protectedRe.test(cmd)) return "protected";
  const j = jobs.find((x) => Number(x.pgid) === Number(pgid));
  if (j) return `mine:${j.jobId || j.label || "job"}`;
  return "foreign";
}


/**
 * 预热的单一所有者判定（纯函数，可单测）。
 * 病根（2026-10-22 实测）：脚本 EXIT trap 里 `( … ) &` 后台预热，工具侧看到 marker 时
 * 那行 self-recall-warm= 还没写出来 ⇒ 工具又发一个预热请求 ⇒ 两个请求抢同一个装载，
 * 第二个被 provider 拒 ⇒ warmOk:false / warmMs:0，但内存确实被第一个装回来了（53 GB）。
 * 判据：有脚本结论就用它；已经装载就不要再打一次；都没有才自己发。
 */
export function decideWarm({ scriptWarmCode = "", alreadyLoaded = false } = {}) {
  if (scriptWarmCode === "200") return { by: "script", ok: true };
  if (alreadyLoaded) return { by: "already-loaded", ok: true };
  return { by: "self", ok: false };
}

export function markerIn(file) {
  try { const hit = readFileSync(file, "utf8").match(/marker=(\S+)/); return hit ? hit[1] : ""; }
  catch { return ""; }
}

/** 等脚本 EXIT trap 写出 self-recall-warm=<code>（后台 subshell，可能晚于 marker 几十秒）。 */
async function waitScriptWarm(file, maxSec = 120) {
  const t0 = Date.now();
  while ((Date.now() - t0) / 1000 < maxSec) {
    const code = selfWarmCode(file);
    if (code) return code;
    await sleep(2000);
  }
  return "";
}

export function selfWarmCode(file) {
  try { const hit = readFileSync(file, "utf8").match(/self-recall-warm=(\d+)/); return hit ? hit[1] : ""; }
  catch { return ""; }
}

// R5：任务脚本自带回归。任务进程是 setsid 脱离会话的，harness 放不放弃这次工具调用与它无关 ⇒
// 任务一结束模型就装回来，用户回来时是热的。用 EXIT trap 实现：正常退出 / set -e 中断 / exit N 都触发；
// SIGKILL 触发不了 ⇒ 由 R4 定时器兜底。auxModels 先卸（谁卸谁），warm 子 shell 后台化，不阻塞任务退出。
export function selfWarmSnippet(cfg, targetModel = null) {
  const clean = (s) => String(s).replace(/["'`$\\]/g, "");
  const ep = clean(cfg.endpoint);
  const model = clean(targetModel || cfg.model);
  const unloadPath = clean(cfg.unloadPath);
  const aux = (cfg.auxModels || []).map(clean).filter(Boolean);
  const payload = JSON.stringify(JSON.stringify({ model, messages: [{ role: "user", content: "ok" }], max_tokens: 1 }));
  return [
    "# ---- self-recall 自动回归（插件追加，勿删）----",
    "__self_recall_warm() {",
    '  [ "${SELF_RECALL_WARM:-1}" = "1" ] || return 0',
    "  ( set +e",
    ...aux.map((m) => `    curl -s -m 30 -X POST ${JSON.stringify(`${ep}${unloadPath}/${m}`)} >/dev/null 2>&1`),
    `    code=$(curl -s -o /dev/null -w '%{http_code}' -m 900 -X POST ${JSON.stringify(`${ep}/v1/chat/completions`)} -H 'content-type: application/json' -d ${payload})`,
    '    echo "self-recall-warm=$code"',
    "  ) &",
    "}",
    "trap __self_recall_warm EXIT",
    "",
  ].join("\n");
}

const SKILL_TEXT = `---
name: arbitrate-serial-work
description: 需要大内存的后台任务（转写/编译/大文件处理/批量下载/训练）与按需装载的本地 LLM 争抢内存时的串行工作法：卸载模型 → 后台跑 → 等 marker → 自动召回。配合 dsh-self-recall 插件的 arbitrate_* 工具使用。
---

# 串行资源仲裁（arbitrate-serial-work）

适用：模型由"收到请求才装载"的 provider 服务，且模型常驻内存与重活任务互斥。
前提：会话装有 dsh-self-recall 插件（保活 + arbitrate_* 工具）。

## 唯一正确姿势
1. \`arbitrate_status\` 读模型状态、MemAvailable 与红线判定（green/yellow/red）。
2. \`arbitrate_run\` 一次性提交脚本 + 超时。它内部完成
   卸载模型 → setsid 脱离会话后台启动 → 轮询 marker → 返回日志尾部。
   **工具调用期间回合保持打开；返回后的那次生成即触发模型按需装载 → 会话自动召回。**
3. 拿到返回立刻读结果并汇报；失败按日志尾部判断重跑 / 降级 / 换方案。

## 为什么这样能自动召回
- 召回是**请求驱动**的：没有任何定时器，只有"请求失败"这一件事会触发插件重试。
- 重活窗口内零请求 = 零装载触发 = 任务独占内存；这靠"回合停在阻塞工具调用里"保证。
- 工具返回 → harness 发出请求 → provider 收到请求即刻开始装载 → 装载完成即服务 → 我醒来。
- 装载失败 → 插件按退避无上限重发同一个请求，直到装载成功（回合不死）。

## 铁律
- 脚本必须写 marker（成功和失败都写，格式 \`marker=<值>\`），否则调用方只能干等到超时。
- 不要把回合干净结束去"等任务"：没有请求在飞，就没有任何东西触发召回。
- 不要加看门狗杀 provider 的装载子进程：那等于掐断召回链（看门狗只适合 <5 分钟且必须压制装载的短任务）。
- 绝不杀 provider 本体、宿主进程、用户浏览器。
- 红线以 \`arbitrate_status\` 的 verdict 为准，不要凭记忆里的固定数字决策。
- 本机专属事实（provider 端点、模型名、内存数字、实测数据集）写进本地技能，不要写进插件。
`;

export function apply(ctx, config = {}) {
  const cfg = {
    initialDelayMs: num(config.initialDelayMs, DEFAULTS.initialDelayMs, 200),
    maxDelayMs: num(config.maxDelayMs, DEFAULTS.maxDelayMs, 1000),
    jitterRatio: num(config.jitterRatio, DEFAULTS.jitterRatio, 0),
    maxAttempts: num(config.maxAttempts, DEFAULTS.maxAttempts, 0),
    resetAfterMs: num(config.resetAfterMs, DEFAULTS.resetAfterMs, 10000),
    endpoint: str(config.endpoint, DEFAULTS.endpoint).replace(/\/+$/, ""),
    model: str(config.model, DEFAULTS.model),
    unloadPath: str(config.unloadPath, DEFAULTS.unloadPath),
    statusPath: str(config.statusPath, DEFAULTS.statusPath),
    memFloorMB: num(config.memFloorMB, DEFAULTS.memFloorMB, 0),
    freeRunMB: num(config.freeRunMB, DEFAULTS.freeRunMB, 1024),
    modelGB: num(config.modelGB, DEFAULTS.modelGB, 1),
    warmAfterRun: config.warmAfterRun !== false,
    pendingWarm: config.pendingWarm !== false,
    warmSelfScript: config.warmSelfScript !== false,
    warmOnlyLocalSession: config.warmOnlyLocalSession !== false,
    pendingScanMs: num(config.pendingScanMs, DEFAULTS.pendingScanMs, 5000),
    auxModels: arr(config.auxModels, DEFAULTS.auxModels),
    localModels: arr(config.localModels, DEFAULTS.localModels),
    // 2026-10-22：以下键此前只加了 schema 与 DEFAULTS，**漏进这个白名单解析器** ⇒ 配置覆盖被静默忽略。
    failFastSec: num(config.failFastSec, DEFAULTS.failFastSec, 0),
    stallMinutes: num(config.stallMinutes, DEFAULTS.stallMinutes, 0),
    attemptBudget: num(config.attemptBudget, DEFAULTS.attemptBudget, 0),
    circuitAfter: num(config.circuitAfter, DEFAULTS.circuitAfter, 0),
    ledgerPath: str(config.ledgerPath, DEFAULTS.ledgerPath),
    singleWindow: config.singleWindow !== false,
    lockPath: str(config.lockPath, DEFAULTS.lockPath),
    jobDir: str(config.jobDir, DEFAULTS.jobDir),
  };
  const log = ctx.logger;
  let attempts = 0, lastFailure = 0;

  // ── 1) 保活 ─────────────────────────────────────────────────────────
  const dispose = ctx.on("agent/request-error", async (payload, next) => {
    let decision;
    try { decision = await next(); }
    catch (e) { log?.warn?.(`self-recall: downstream recovery failed, taking over: ${e?.message ?? e}`); }
    if (decision && decision.kind === "retry") return decision;
    const signal = payload?.signal;
    if (signal?.aborted) return;
    const now = Date.now();
    if (now - lastFailure > cfg.resetAfterMs) attempts = 0;
    lastFailure = now;
    attempts += 1;
    if (cfg.maxAttempts > 0 && attempts > cfg.maxAttempts) {
      log?.warn?.(`self-recall: giving up after ${cfg.maxAttempts} attempts (provider "${payload?.provider}")`);
      attempts = 0;
      return;
    }
    const base = Math.min(cfg.maxDelayMs, cfg.initialDelayMs * 2 ** Math.min(attempts - 1, 8));
    const delayMs = Math.max(200, Math.round(base * (1 + (Math.random() * 2 - 1) * cfg.jitterRatio)));
    log?.warn?.(`self-recall: attempt #${attempts} provider "${payload?.provider}" code=${payload?.failure?.code ?? "unknown"} in ${delayMs}ms`);
    if (!await sleep(delayMs, signal)) return;
    return { kind: "retry" };
  });
  ctx.effect(() => () => dispose(), "self-recall: dispose request-error listener");

  // ── 1a) 记住当前会话的模型路由（决定该不该预热本地模型）──────────────
  const disposeRoute = ctx.on("agent/request", async (_payload, next) => {
    const c = await next();
    try { lastRoute = { provider: c?.provider, model: c?.model }; } catch { /* 只观测，绝不改配置 */ }
    return c;
  });
  ctx.effect(() => () => disposeRoute(), "self-recall: dispose route listener");

  // ── 1b) 待回归兜底（R1，2026-10-14 中断事故修补）──────────────────────────
  // 覆盖「工具调用被中断/放弃 ⇒ 挂在调用尾部的 warm 一起被弃」这条实测路径；跨宿主重启同样成立。
  // 硬约束：任务还在跑 ⇒ 绝不装回（串行独占不破）。
  let lastPendingWarm = 0;
  // 会话事实（harness 侧真值）：给模型一个「读」的入口，而不是让它凭记忆写逐字原文。
  // 依据 CaMeL（控制流/数据流分离）：授权与复述都不能来自模型自己写的字。
  // 逐会话存储：模块级单槽会让 A 会话的「最新用户消息」被 B 会话读到（2026-10-22 串台）。
  const facts = new WeakMap();      // agent → { text, at, turn }
  const routes = new WeakMap();     // agent → { provider, model }（跨会话不共用路由）
  let lastFact = null;              // 取不到 agent 时的退路
  let lastTurn = 0;
  try {
    ctx.on("agent/pre-step", async (payload, next) => {
      if (payload?.agent && payload?.route) routes.set(payload.agent, { provider: payload.route.provider, model: payload.route.model });
      const f = sessionFactFrom(payload?.messages, Date.now(), Number(payload?.turn) || 0);
      if (f) noteSessionFact(payload?.agent, f);
      return next();
    });
  } catch { /* 取不到事件就退化成 null，工具会如实说"未知" */ }

  const noteSessionFact = (agent, fact) => {
    if (!fact) return;
    if (agent) facts.set(agent, fact);
    lastFact = fact; lastTurn = fact.turn;
  };
  /** 测试用：给某会话喂一条事实。 */
  globalThis.__selfRecallNoteFact = noteSessionFact;

  const disposePending = ctx.on("agent/pre-step", async (payload, next) => {
    const res = await next();
    try {
      if (!cfg.pendingWarm) return res;
      const p = await readPending();
      if (!p) return res;
      if (Date.now() - (p.at || 0) > PENDING_MAX_AGE_MS) { await clearPending(); return res; }
      if (jobAlive(p.dir)) return res;                        // 任务还在跑 ⇒ 独占不破
      if (cfg.warmOnlyLocalSession && !routeIsLocal(cfg, p.route)) {
        await clearPending();
        log?.warn?.(`self-recall: pre-step 跳过预热 — 会话路由 "${p.route?.model ?? lastRoute?.model ?? "?"}" 不在本地模型表 [${localModels(cfg).join(", ")}]`);
        return res;
      }
      if (Date.now() - lastPendingWarm < 60000) return res;   // 节流：warm 失败时别每步刷装载
      lastPendingWarm = Date.now();
      const tgt = str(p.model, cfg.model);                    // 装回**当时卸掉的那个**，不是写死的主模型
      const st = await modelStatus({ ...cfg, model: tgt });
      if (st === "loaded") { await clearPending(); return res; }
      for (const m of cfg.auxModels) {
        const u = await unloadModel({ ...cfg, model: m });
        if (!u.ok) log?.warn?.(`self-recall: aux unload "${m}" failed: ${u.body}`);
      }
      const w = await warmModel({ ...cfg, model: tgt });
      log?.warn?.(`self-recall: agent/pre-step 补 warm ${tgt} ok=${w.ok} status=${w.status}（pending 起于 ${new Date(p.at).toISOString()}）`);
      if (w.ok === true) await clearPending();
    } catch (e) { log?.warn?.(`self-recall: pre-step pending warm error: ${e?.message ?? e}`); }
    return res;
  });
  ctx.effect(() => () => disposePending(), "self-recall: dispose pre-step listener");

  // ── 1c) 定时器兜底（R4）：不依赖任何请求 ──────────────────────────────────
  // 结构性缺口：pre-step 是请求驱动的接缝，会话空闲 + 模型离线 ⇒ harness 里没有任何东西会点火。
  // 这条覆盖「脚本被 SIGKILL/OOM 掉、没机会自 warm，而会话空闲无请求」⇒ 插件自己按周期检查 pending 并补 warm。
  // 硬约束不变：任务进程还在跑 ⇒ 绝不装回；内存低于红线 ⇒ 不动；已 loaded ⇒ 只清标记。
  let scanBusy = false;
  const scanTimer = setInterval(async () => {
    if (scanBusy || !cfg.pendingWarm) return;
    scanBusy = true;
    try {
      const p = await readPending();
      if (!p) return;
      if (Date.now() - (p.at || 0) > PENDING_MAX_AGE_MS) { await clearPending(); return; }
      if (jobAlive(p.dir)) return;
      if (cfg.warmOnlyLocalSession && !routeIsLocal(cfg, p.route)) {
        await clearPending();
        log?.warn?.(`self-recall: 定时兜底跳过预热 — 会话路由 "${p.route?.model ?? lastRoute?.model ?? "?"}" 不在本地模型表 [${localModels(cfg).join(", ")}]`);
        return;
      }
      const tgt = str(p.model, cfg.model);                    // 装回**当时卸掉的那个**
      const st = await modelStatus({ ...cfg, model: tgt });
      if (st === "loaded") { await clearPending(); return; }
      const mem = await memInfo();
      if (mem.memAvailableMB < cfg.memFloorMB) {
        log?.warn?.(`self-recall: 定时兜底跳过 — MemAvailable ${mem.memAvailableMB}MB < 红线 ${cfg.memFloorMB}MB`);
        return;
      }
      if (Date.now() - lastPendingWarm < 60000) return;
      lastPendingWarm = Date.now();
      for (const m of cfg.auxModels) {
        const u = await unloadModel({ ...cfg, model: m });
        if (!u.ok) log?.warn?.(`self-recall: aux unload "${m}" failed: ${u.body}`);
      }
      const w = await warmModel({ ...cfg, model: tgt });
      log?.warn?.(`self-recall: 定时器补 warm ${tgt} ok=${w.ok} status=${w.status}（pending 起于 ${new Date(p.at).toISOString()}）`);
      if (w.ok === true) await clearPending();
    } catch (e) { log?.warn?.(`self-recall: 定时兜底异常: ${e?.message ?? e}`); }
    finally { scanBusy = false; }
  }, cfg.pendingScanMs);
  ctx.effect(() => () => clearInterval(scanTimer), "self-recall: dispose pending scanner");

  // ── 2) 内化：注入系统提示（官方通道；机器事实一律来自 config，不硬编码）──
  const systemPrompt = ctx.get("systemPrompt");
  systemPrompt?.section?.({
    name: "self-recall:arbitration",
    order: 500,
    text: () => {
      const host = cfg.endpoint.replace(/^https?:\/\//, "").replace(/\/.*$/, "");
      const floorGB = Math.round(cfg.memFloorMB / 1024);
      const freeGB = Math.round(cfg.freeRunMB / 1024);
      // 2026-10-16：这里写的是**本会话当前该用的本地模型**（会话在 -256k 上就写 -256k），不再写死 config.model
      const tgt = localTarget(cfg) || cfg.model;
      return [
        "## 串行资源仲裁（self-recall）",
        `本会话的模型由按需装载的 provider 服务（${host}${tgt ? `，模型 ${tgt}` : ""}，约 ${cfg.modelGB}GB 常驻内存）。需要大内存的后台任务与该模型共存会互相挤占内存。`,
        "- **触发判据（硬，看到就触发，不必等用户提醒）**：预计单条命令要跑 >60 秒 —— 编译 / 重建 / 大下载 / 语音转写 / 批量识图 / 大文件校验与哈希 / 长文生成 / 任何要等磁盘大读的活 —— **必须用 `arbitrate_run` 提交，禁止直接 bash 前台跑**。多个任务尽量合并进一次窗口，回归的 30–45 秒只付一次。",
        "- 提交这类任务只用 `arbitrate_run`：卸载模型 → setsid 后台启动脚本 → 轮询 marker → 返回结果。**`timeoutSec` 硬上限 900 秒**（超出会被插件压到 900，返回体 `capSec` 告诉你实际值）：更长的活拆窗，每窗留一个中间 marker。工具调用期间回合保持打开，返回时模型被按需装载、会话自动召回，无需用户发起对话。**装卸对象 = 本会话当前用的那个本地模型**（按会话路由解析，`config.localModels` 内任一命中即用；跟随你会话里选的纯文本/弹性条目，不写死一条）。",
        "- `arbitrate_run` 在 marker 到手后自动回归：先卸 config.auxModels（谁卸谁）再发 1 token 预热主模型（返回 `warmMs`/`warmOk`），provider 装载的 30–45 秒吃在工具调用里，用户下一条消息直接命中热模型；连续跑重活时传 `warm:false` 省这段时间。",
        "- **待回归兜底（插件保证，不靠自觉，四层闭环）**：`arbitrate_run` 卸载成功即落盘 pending 标记。**① 任务脚本自带回归**（插件在脚本头部注入 EXIT trap：任务一退出就卸 auxModels 并发 1 token 装回主模型，与 harness 是否放弃这次调用无关）；**② 插件定时器**每 `pendingScanMs` 毫秒检查 pending，任务进程已退出就补 warm（会话空闲无请求也照跑）；**③ 回合开始前**（`agent/pre-step`）检查 pending 补 warm；**④ 超时分支**补判迟到 marker 与任务进程状态。**任务进程还在跑时四层全部绝不装回**（串行独占不破）。`arbitrate_warm` 成功也会清掉标记。",
        "- **重跑治理（插件侧，按失败类型判）**：首次直接跑；上次是 stall/timeout（intermittent）⇒ 必须填 change（一句「上次为什么失败 + 这次改了什么」），且在同脚本 attemptBudget 次预算内；上次 script-died/no-start 且日志里有 syntax error / No such file / permission denied（permanent）⇒ 拒绝重跑，返回体直接给出上次错误行；宿主重启或中断类（transient）⇒ 原样放行。返回体的 previous/attempt/rerunWhy 说明它为什么允许或拒绝。",
        "- 任务脚本必须写 marker（成功和失败都要写，格式 `marker=<值>`）。**早退三态**：`script-died`（进程退了没写 marker）/ `no-start`（压根没起来）/ `stall`（活着但日志静默 `stallMinutes`）——都不再干等到超时；返回体的 `reason`/`died`/`stall`/`quietSec` 会告诉你是哪种。**脚本不要 `exec` 重定向自己的 stdout** —— 插件已把 stdout 接进 job.log，抢走 stdout 会让 marker 永远读不到（2026-10-14 实测踩过）。",
        `- 跑重活前后用 \`arbitrate_status\` 看红线：MemAvailable ≥${freeGB}GB 自由跑；≥${floorGB}GB 降级并不碰模型；低于它才卸载。始终为用户保留 ≥${floorGB}GB 轻量办公余量。`,
        "- **杀进程按身份，不按模式**：`arbitrate_run` 返回 `jobId`；要清掉窗口就 `proc_kill({jobId})`——它杀的是那个**进程组**，构造上不含你自己的调用链。不知道是谁就先 `proc_list`（带归属：self / protected / mine:<jobId> / foreign），再按 pid 精确杀。**禁止在 shell 里按命令行模式挑进程再杀**：命令自己的命令行含那个模式，必然把自己算进匹配集（2026-10-22 实测把本次调用链一起 SIGTERM）。",
        "- 绝不杀 provider 的装载子进程/进程组，也不要杀宿主进程与用户浏览器——那会掐断召回链，会话将无法自动恢复。",
        `- 长时间离线由本插件保活：模型请求失败后按 ${Math.round(cfg.initialDelayMs / 1000)}→${Math.round(cfg.maxDelayMs / 1000)} 秒退避重试${cfg.maxAttempts > 0 ? `，上限 ${cfg.maxAttempts} 次` : "，无上限"}。`,
      ].join("\n");
    },
  });

  // ── 3) 技能分发（缺失才写，不覆盖用户版本；shipSkill:false 可关闭）──
  if (config.shipSkill !== false) {
    ctx.effect(async () => {
      try {
        const dir = join(homedir(), ".dsh", "skills", "arbitrate-serial-work");
        const file = join(dir, "SKILL.md");
        let exists = true;
        try { await access(file); } catch { exists = false; }
        if (!exists) {
          await mkdir(dir, { recursive: true });
          await writeFile(file, SKILL_TEXT, "utf8");
          log?.warn?.("self-recall: skill installed → ~/.dsh/skills/arbitrate-serial-work/SKILL.md");
        }
      } catch (e) { log?.warn?.(`self-recall: skill install skipped: ${e.message}`); }
    }, "self-recall: ship bundled skill");
  }

  // ── 3) 工具 ─────────────────────────────────────────────────────────
  const disposers = [];

  const renderJson = (_a, v) => [{ type: "text", text: JSON.stringify(v) }];

  disposers.push(ctx.tools.register(defineTool({
    name: "session_facts",
    description: "读本会话的权威事实（由 harness 记录，经得起引用）：最近一条用户消息的逐字原文、时间、回合号。**需要引用用户原话时调它，不要凭上下文回忆写**——回忆写出来的逐字引语是幻觉高发区（实测被编成过「继续」）。",
    parameters: {},
    output: {
      schema: {
        type: "object",
        additionalProperties: false,
        properties: {
          known: { type: "boolean", required: true },
          text: { type: "string", required: true },
          atIso: { type: "string", required: true },
          turn: { type: "number", required: true },
          note: { type: "string", required: true },
        },
      },
      render: renderJson,
    },
    async execute(_args, exec) {
      const mine = exec?.agent ? facts.get(exec.agent) : undefined;
      const f = mine || null;
      if (!f) {
        return { known: false, text: "", atIso: "", turn: 0, note: "本会话尚未被 harness 捕获到用户消息（刚重启或还没发过言）" };
      }
      return {
        known: true,
        text: f.text,
        atIso: new Date(f.at).toISOString(),
        turn: f.turn,
        note: "本会话的用户消息（逐字，harness 记录；按会话隔离）",
      };
    },
  })));


  disposers.push(ctx.tools.register(defineTool({
    name: "proc_list",
    description: "看本机进程**是谁**：列出 pid/pgid/归属（self=我自己的调用链，protected=宿主/llama-swap/引擎，mine:<jobId>=本会话起的重活窗口，foreign=其它），默认已剔除自己与父链。要杀进程前先调它，按 pid 精确杀，不要用命令行模式搜索（那会把这条命令自己的 shell 也算进去）。",
    parameters: {
      match: { type: "string", description: "可选：只列命令行里含该子串的进程（过滤在工具内部做，避免你在 shell 里写模式）" },
      limit: { type: "number", description: "最多返回几行，默认 40" },
    },
    output: {
      schema: {
        type: "object",
        additionalProperties: false,
        properties: {
          rows: { type: "array", required: true, items: { type: "string" } },
          total: { type: "number", required: true },
          hiddenSelf: { type: "number", required: true },
        },
      },
      render: renderJson,
    },
    async execute({ match, limit } = {}) {
      const jobs = await readJobs(cfg);
      const selfPids = selfChain();
      const out = spawnSync("ps", ["-eo", "pid=,ppid=,pgid=,etimes=,args="], { encoding: "utf8", timeout: 8000 });
      const rows = [];
      let hiddenSelf = 0;
      for (const line of String(out.stdout || "").split("\n")) {
        const t = line.trim();
        if (!t) continue;
        const m = t.match(/^(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s+(.*)$/);
        if (!m) continue;
        const pid = Number(m[1]), ppid = Number(m[2]), pgid = Number(m[3]), etimes = Number(m[4]);
        const cmd = m[5].slice(0, 300);
        if (selfPids.has(pid)) { hiddenSelf += 1; continue; }
        if (match && !cmd.includes(String(match))) continue;
        const owner = ownerOf({ pid, pgid, cmd }, { selfPids, jobs });
        const who = `pid=${pid} ppid=${ppid} pgid=${pgid} 已运行=${etimes}s 归属=${owner} cmd=${cmd.slice(0, 140)}`;
        rows.push(who);
      }
      const cap = Math.max(1, Math.min(Number(limit) || 40, 200));
      return { rows: rows.slice(0, cap), total: rows.length, hiddenSelf };
    },
  })));

  disposers.push(ctx.tools.register(defineTool({
    name: "proc_kill",
    description: "按**身份**终止进程：给 jobId ⇒ 杀该作业的整个进程组（构造上不含调用者）；给 pids ⇒ 逐个核对归属，self/protected 一律拒绝，foreign 必须带 confirm:true。不要再用命令行模式挑进程。",
    parameters: {
      jobId: { type: "string", description: "作业 id（arbitrate_run 返回的 jobId）" },
      pids: { type: "array", items: { type: "number" }, description: "要杀的 pid 列表" },
      confirm: { type: "boolean", description: "杀 foreign 进程时必须为 true" },
      signal: { type: "string", description: "TERM（默认）或 KILL" },
    },
    output: {
      schema: {
        type: "object",
        additionalProperties: false,
        properties: {
          ok: { type: "boolean", required: true },
          killed: { type: "array", required: true, items: { type: "number" } },
          refused: { type: "array", required: true, items: { type: "string" } },
          note: { type: "string", required: true },
        },
      },
      render: renderJson,
    },
    async execute({ jobId, pids, confirm, signal } = {}) {
      const sig = String(signal || "TERM").toUpperCase() === "KILL" ? "SIGKILL" : "SIGTERM";
      const jobs = await readJobs(cfg);
      const selfPids = selfChain();
      const killed = [], refused = [], notes = [];
      const job = jobId ? jobs.find((j) => j.jobId === jobId) : undefined;
      if (jobId && !job) return { ok: false, killed, refused: [`未知 jobId: ${jobId}`], note: "用 proc_list 看有哪些作业" };
      if (job) {
        const info = procInfo(Number(job.pid));
        if (selfPids.has(Number(job.pid))) refused.push(`jobId ${jobId} 的进程属于我自己的调用链，拒绝`);
        else if (!info.alive) notes.push(`作业 ${jobId} 已退出（pid 不存在），无需终止`);
        else {
          try { process.kill(-Number(job.pgid), sig); killed.push(...[]); notes.push(`已向进程组 -${job.pgid} 发 ${sig}`); }
          catch (e) { refused.push(`发信号失败: ${e && e.message}`); }
        }
      }
      const list = Array.isArray(pids) ? pids.map(Number).filter((x) => Number.isInteger(x) && x > 0) : [];
      for (const pid of list) {
        if (selfPids.has(pid)) { refused.push(`pid ${pid} 在我自己的调用链里，拒绝`); continue; }
        const info = procInfo(pid);
        if (!info.alive) { refused.push(`pid ${pid} 不存在`); continue; }
        const cmd = (() => { try { return readFileSync(`/proc/${pid}/cmdline`, "utf8").replace(/\0/g, " ").trim(); } catch { return ""; } })();
        const owner = ownerOf({ pid, pgid: info.pgid, cmd }, { selfPids, jobs });
        if (owner === "protected") { refused.push(`pid ${pid} 是受保护进程（宿主/llama-swap/引擎），只能走用户授权`); continue; }
        if (owner === "foreign" && confirm !== true) { refused.push(`pid ${pid} 是 foreign（${cmd.slice(0, 60)}），要杀请带 confirm:true 并说明理由`); continue; }
        try { process.kill(pid, sig); killed.push(pid); } catch (e) { refused.push(`pid ${pid} 发信号失败: ${e && e.message}`); }
      }
      return { ok: Boolean(killed.length > 0 || (job && notes.length > 0)), killed, refused, note: notes.join("；") || (killed.length ? `已发 ${sig}` : "什么也没做") };
    },
  })));

  disposers.push(ctx.tools.register(defineTool({
    name: "arbitrate_status",
    description: "查看串行仲裁的决策依据：本地模型装载状态、MemAvailable、SwapFree，以及内存红线判定（green/yellow/red）。跑重活前后都该调一次。",
    parameters: {},
    output: {
      schema: {
        type: "object",
        additionalProperties: false,
        properties: {
          model: { type: "string", required: true },
          modelStatus: { type: "string", required: true },
          memAvailableMB: { type: "number", required: true },
          swapFreeMB: { type: "number", required: true },
          memFloorMB: { type: "number", required: true },
          verdict: { type: "string", required: true, enum: ["green", "yellow", "red"] },
        },
      },
      render: renderJson,
    },
    async execute() {
      const mem = await memInfo();
      // 报的是**本会话该用的本地模型**的状态（会话在 -256k 上就别去问纯文本那条）
      const tgt = localTarget(cfg) || cfg.model;
      const status = await modelStatus({ ...cfg, model: tgt });
      const verdict = mem.memAvailableMB >= 8192 ? "green"
        : mem.memAvailableMB >= cfg.memFloorMB ? "yellow" : "red";
      return {
        model: tgt,
        modelStatus: String(status),
        memAvailableMB: mem.memAvailableMB,
        swapFreeMB: mem.swapFreeMB,
        memFloorMB: cfg.memFloorMB,
        verdict,
      };
    },
  })));

  disposers.push(ctx.tools.register(defineTool({
    name: "arbitrate_run",
    description: "串行执行一个需要大内存的后台任务：卸载本地模型 → setsid 后台启动脚本 → 轮询 marker → 返回结果。工具调用期间回合保持打开，返回时模型被按需装载、会话自动召回。脚本必须自己写 marker（成功和失败都要写，格式 marker=<值>）。**早期失败自动早退**：进程退出却没写 marker ⇒ marker=script-died / no-start；进程活着但日志静默 N 分钟 ⇒ marker=stall（都不再干等到超时）。marker 到手后自动回归：先卸 config.auxModels（谁卸谁）再发 1 token 预热主模型，把 provider 装载耗时吃在本调用里（见 warmMs/warmOk），用户下一条消息直接命中热模型。禁止在脚本里加看门狗杀 llama-swap 子进程。**重跑治理**：同一脚本再提交时，插件带上上次结果（`previous`），按失败类型三分（transient 放行 / intermittent 要 `change` 且限 `attemptBudget` 次 / permanent 直接拒）；连续 `circuitAfter` 次同因失败熔断，要求换方法。**timeoutSec 上限 900 秒（硬压）：更长的活必须拆成多个窗口**，每个窗口写一个中间 marker；拆不动就先改脚本让它能分段。",
    parameters: {
      script: { type: "string", required: true, description: "要执行的 bash 脚本内容。约定：结束时 echo 'marker=<值>'。" },
      label: { type: "string", description: "短标签，用于命名工作目录（默认 job）。" },
      change: { type: "string", description: "重跑时必须填：上次为什么失败 + 这次改了什么（一行）。首次提交可省略。transient 类失败不要求。" },
      timeoutSec: { type: "number", description: "最长等待秒数，默认 900，**上限 900（超出会被压到 900）**。更长的活拆窗。" },
      unload: { type: "boolean", description: "是否先卸载模型，默认 true。" },
      warm: { type: "boolean", description: "任务结束后是否自动回归并预热：先按「谁卸谁」卸掉 config.auxModels，再发 1 token 请求触发 provider 装载，把装载耗时吃在本工具调用里。默认取 config.warmAfterRun；马上还要接着跑重活时传 false。" },
    },
    output: {
      schema: {
        type: "object",
        additionalProperties: false,
        properties: {
          marker: { type: "string", required: true, description: "脚本写出的 marker；空串表示没等到。" },
          reason: { type: "string", required: true, description: "marker | marker-late | script-died | no-start | stall | timeout" },
          jobId: { type: "string", required: true, description: "本次作业身份（proc_kill 用它按组终止，不必搜索进程）" },
          capSec: { type: "number", required: true, description: "本次实际生效的等待上限（硬上限 900）" },
          previous: { type: "string", required: true, description: "同一脚本上一次尝试的 JSON（空串 = 首次）。含 reason/marker/workdir/logTail" },
          attempt: { type: "number", required: true, description: "同一脚本的第几次尝试" },
          rerunDenied: { type: "boolean", required: true, description: "true = 本次因重跑治理被拒，未启动" },
          rerunWhy: { type: "string", required: true, description: "first-run | transient | intermittent+change | permanent | budget-exhausted | circuit-open | need-change" },
          died: { type: "boolean", required: true, description: "进程退出却没写 marker" },
          stall: { type: "boolean", required: true, description: "进程活着但日志静默" },
          quietSec: { type: "number", required: true, description: "日志静默了多少秒" },
          timedOut: { type: "boolean", required: true },
          elapsedSec: { type: "number", required: true },
          unloadOk: { type: "boolean", required: true },
          unloadBody: { type: "string", required: true },
          memBeforeMB: { type: "number", required: true },
          memAfterMB: { type: "number", required: true },
          logTail: { type: "string", required: true, description: "任务日志最后 40 行。" },
          workdir: { type: "string", required: true },
          warmMs: { type: "number", required: true, description: "自动回归+预热耗时（秒）；未做为 0。" },
          warmOk: { type: "boolean", required: true, description: "预热请求是否成功（模型已装载并热身）；未做为 false。" },
          warmBy: { type: "string", required: true, description: "script=脚本EXIT trap / already-loaded=已装载 / self=工具自己发 / skipped" },
        },
      },
      render: renderJson,
    },
    async execute({ script, label, timeoutSec, unload, warm, change }, exec) {
      // 2026-10-22 用户令：硬压 900 秒。规则「timeoutSec ≤900」变成机制，
      // 不再依赖模型自觉。更长的活必须拆窗（每次窗口留一个中间 marker）。
      const CAP_MAX_SEC = 900;
      const cap = Math.min(Math.max(Number(timeoutSec) || 900, 30), CAP_MAX_SEC);
      const tag = String(label || "job").replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 24) || "job";
      const jobId = `${tag}-${Date.now()}`;
      const dir = join(tmpdir(), `arbitrate-${tag}-${Date.now()}`);
      await mkdir(dir, { recursive: true });
      const before = await memInfo();
      // ── 单窗口：已有重活窗口在跑 ⇒ 拒（并行在本机无收益，只会互相抢显存/内存）──
      if (cfg.singleWindow !== false) {
        const busy = liveWindowLock(cfg);
        if (busy) {
          return {
            marker: "", reason: "window-busy", jobId, capSec: cap, died: false, stall: false, timedOut: false,
            quietSec: 0, previous: "", attempt: 1, rerunDenied: true, rerunWhy: "window-busy",
            elapsedSec: 0, unloadOk: true, unloadBody: "skipped(已有窗口在跑，未卸载模型)",
            memBeforeMB: before.memAvailableMB, memAfterMB: before.memAvailableMB,
            logTail: `已有重活窗口在跑：${busy.label || "未标注"} pid=${busy.pid}，起于 ${new Date(busy.at).toISOString()}`,
            workdir: "", warmMs: 0, warmOk: false,
          };
        }
      }
      // ── 重跑治理：同脚本的历史尝试（台账）→ 按失败类型决定 ──────────────
      const scriptBody = typeof script === "string" ? script : "";
      const scriptHash = createHash("sha256").update(scriptBody).digest("hex").slice(0, 16);
      const lfile = ledgerFile(cfg);
      const mine = (await readLedger(lfile)).filter((e) => e && e.hash === scriptHash);
      const prev = mine.length ? mine[mine.length - 1] : null;
      const attempt = mine.length + 1;
      let streak = 0;
      for (let i = mine.length - 1; i >= 0; i -= 1) { if (mine[i].reason === (prev && prev.reason)) streak += 1; else break; }
      const decision = decideRerun({
        prev, change, attemptBudget: Number(cfg.attemptBudget) || 0,
        circuitAfter: Number(cfg.circuitAfter) || 0, sameReasonStreak: streak,
      });
      if (decision.action === "deny") {
        const prevJson = prev ? JSON.stringify({
          at: new Date(prev.at || 0).toISOString(), reason: prev.reason, marker: prev.marker,
          quietSec: prev.quietSec, attempt: prev.attempt, workdir: prev.workdir,
          logTail: String(prev.logTailTail || "").slice(-600),
        }) : "";
        return {
          marker: "", reason: "rerun-denied", jobId, capSec: cap, died: false, stall: false, timedOut: false,
          quietSec: 0, previous: prevJson, attempt, rerunDenied: true, rerunWhy: decision.why,
          elapsedSec: 0, unloadOk: true, unloadBody: "skipped(重跑被拒，未卸载模型)",
          memBeforeMB: before.memAvailableMB, memAfterMB: before.memAvailableMB,
          logTail: String((prev && prev.logTailTail) || ""), workdir: String((prev && prev.workdir) || ""),
          warmMs: 0, warmOk: false,
        };
      }
      // 卸谁（2026-10-16）：会话命中的本地模型 → 否则端点正在跑的本地模型 → 否则 config.model。不再写死 cfg.model。
      const myRoute = (exec && exec.agent && routes.get(exec.agent)) || lastRoute;
      const target = await unloadTarget(cfg, myRoute);
      const un = unload === false ? { ok: true, body: "skipped" } : await unloadModel({ ...cfg, model: target });
      const sh = join(dir, "job.sh");
      const out = join(dir, "job.log");
      // 只有真的卸过才欠一次回归——unload=false（同模型不卸）时模型没走，不写标记
      if (unload !== false && cfg.pendingWarm && un.ok) await writePending({ dir, out, label: tag, model: target, route: myRoute });
      // R5：把回归写进任务脚本本身（EXIT trap），任务进程脱离会话 ⇒ 与 harness 是否放弃调用无关
      const doWarmFlag = warm === false ? false : (warm === true ? true : cfg.warmAfterRun);
      const body = typeof script === "string" ? script : "";
      await writeFile(sh, (cfg.singleWindow === false ? "" : windowLockSnippet(cfg, tag, jobId)) + (cfg.warmSelfScript && doWarmFlag ? selfWarmSnippet(cfg, target) : "") + body, "utf8");
      // 单一启动路径：setsid 脱离会话 + 重定向，detached 后 unref，绝不随会话退出
      const runner = spawn("bash", ["-c", `setsid bash ${JSON.stringify(sh)} </dev/null > ${JSON.stringify(out)} 2>&1 &`], {
        cwd: dir,
        detached: true,
        stdio: "ignore",
        env: { ...process.env, SELF_RECALL_WARM: doWarmFlag && (!cfg.warmOnlyLocalSession || routeIsLocal(cfg)) ? "1" : "0" },
      });
      runner.unref?.();
      const t0 = Date.now();
      let marker = "", tail = "", reason = "", lastSize = -1, lastChangeAt = Date.now(), quietSec = 0;
      const { statSync, readFileSync } = await import("node:fs");
      const failFast = Math.max(Number(cfg.failFastSec) || 0, 3);
      const stallMin = Number(cfg.stallMinutes) || 0;
      while (Date.now() - t0 < cap * 1000) {
        await sleep(3000);
        try {
          const text = readFileSync(out, "utf8");
          tail = text.split("\n").slice(-40).join("\n");
          const hit = text.match(/marker=(\S+)/);
          if (hit) { marker = hit[1]; reason = "marker"; break; }
        } catch { /* 日志还没生成 */ }
        let size = -1;
        try { size = statSync(out).size; } catch { size = -1; }
        if (size !== lastSize) { lastSize = size; lastChangeAt = Date.now(); }
        quietSec = Math.round((Date.now() - lastChangeAt) / 1000);
        const d = pollDecision({
          marker, alive: jobAlive(dir), size, quietSec,
          elapsed: (Date.now() - t0) / 1000, failFast, stallMin, cap,
        });
        if (d.done) {
          if (d.reason === "marker") { reason = "marker"; break; }
          // 迟到的 marker 比"进程死了"更准确
          if (d.reason === "script-died" || d.reason === "no-start") {
            const late = markerIn(out);
            if (late !== "") { marker = late; reason = "marker-late"; break; }
          }
          reason = d.reason;
          break;
        }
      }
      if (reason === "") reason = "timeout";
      // ── 自动回归 + 预热 ─────────────────────────────────────────────
      // 只在 marker 到手后做：marker 没等到 ⇒ 任务可能还在后台跑，此时装回模型 = 违反串行独占。
      // 顺序硬要求：先按「谁卸谁」卸掉重活拉起的辅助模型，再 warm 主模型（辅助模型在场时装主模型会 OOM）。
      let wr = { skipped: true, ms: 0, ok: false };
      const doWarm = doWarmFlag;
      const warmNow = async (why) => {
        if (cfg.warmOnlyLocalSession && !routeIsLocal(cfg, myRoute)) {
          await clearPending();
          log?.warn?.(`self-recall: 跳过回归预热(${why}) — 调用方会话路由 "${lastRoute?.model ?? "?"}" 不在本地模型表 [${localModels(cfg).join(", ")}]`);
          // 主动跳过 ≠ 失败：报 ok:true + by 说明，避免用户在返回体里看到 warmOk:false 误判「没预热」
          return { skipped: true, ms: 0, ok: true, by: "skipped-route" };
        }
        // 单一所有者：先等脚本 EXIT trap 的结论（它是后台 subshell，可能晚于 marker）
        const scriptCode = cfg.warmSelfScript && doWarmFlag ? await waitScriptWarm(out, Math.min(120, cap)) : "";
        let loaded = false;
        if (scriptCode !== "200") {
          const st = String(await modelStatus({ ...cfg, model: target }) ?? "");
          loaded = /ready|loaded|running/i.test(st);
        }
        const plan = decideWarm({ scriptWarmCode: scriptCode, alreadyLoaded: loaded });
        if (plan.by === "script" || plan.by === "already-loaded") {
          await clearPending();
          log?.warn?.(`self-recall: 预热已由 ${plan.by} 完成（script=${scriptCode || "-"}, loaded=${loaded}）⇒ 不重复发请求`);
          return { skipped: true, ms: 0, ok: true, by: plan.by };
        }
        for (const m of cfg.auxModels) {
          const u = await unloadModel({ ...cfg, model: m });
          if (!u.ok) log?.warn?.(`self-recall: aux unload "${m}" failed: ${u.body}`);
        }
        const tw = Date.now();
        const w = await warmModel({ ...cfg, model: target });
        const r = { skipped: false, ms: Math.round((Date.now() - tw) / 1000), ok: w.ok === true, by: "self" };
        if (w.ok === true) await clearPending();
        else log?.warn?.(`self-recall: warm failed(${why}): ${w.error ?? "unknown"}（请求驱动的召回链照旧保底，pending 保留）`);
        return r;
      };
      if (doWarm && marker !== "") {
        wr = await warmNow("marker");
      } else if (doWarm && reason === "stall") {
        // 进程还在跑 ⇒ 绝不装回（串行独占）；pending 交给 agent/pre-step 兜底
        log?.warn?.("self-recall: 判定空转（日志静止）但任务仍在跑 ⇒ 不装回，请查 job.log 或手动终止");
      } else if (doWarm && marker === "") {
        // R2：超时 ≠ 任务没完。marker 后到 或 任务进程已退出 ⇒ 当场补 warm，不留离线态；
        //      任务确实还在跑 ⇒ 绝不装回（串行独占），把回归交给 agent/pre-step 的 pending 兜底。
        const late = markerIn(out);
        if (late !== "") marker = late;
        if (late !== "" || !jobAlive(dir)) wr = await warmNow("timeout+job-done");
        else log?.warn?.("self-recall: 超时且任务仍在跑 ⇒ 不装回，pending 交由 agent/pre-step 兜底");
      }
      await appendLedger(lfile, {
        hash: scriptHash, label: tag, at: Date.now(), reason, marker, quietSec,
        elapsedSec: Math.round((Date.now() - t0) / 1000), attempt,
        logTailTail: String(tail || "").slice(-600), workdir: dir, change: String(change || "").slice(0, 300),
      });
      const after = await memInfo();
      return {
        marker,
        reason,
        jobId,
        capSec: cap,
        previous: prev ? JSON.stringify({ at: new Date(prev.at || 0).toISOString(), reason: prev.reason, attempt: prev.attempt, workdir: prev.workdir, logTail: String(prev.logTailTail || "").slice(-600) }) : "",
        attempt,
        rerunDenied: false,
        rerunWhy: decision.why,
        died: reason === "script-died" || reason === "no-start",
        stall: reason === "stall",
        timedOut: reason === "timeout",
        quietSec,
        elapsedSec: Math.round((Date.now() - t0) / 1000),
        unloadOk: un.ok === true,
        unloadBody: String(un.body ?? ""),
        memBeforeMB: before.memAvailableMB,
        memAfterMB: after.memAvailableMB,
        logTail: tail,
        workdir: dir,
        warmMs: wr.ms,
        warmOk: wr.ok,
        warmBy: String(wr.by || (wr.skipped ? "skipped" : "")),
      };
    },
  })));

  disposers.push(ctx.tools.register(defineTool({
    name: "arbitrate_warm",
    description: "主动把本地模型装回来（发一个 1 token 请求触发按需装载）。用于重活结束后想让会话立刻恢复、或用户即将交互时。",
    parameters: {},
    output: {
      schema: {
        type: "object",
        additionalProperties: false,
        properties: {
          ok: { type: "boolean", required: true },
          modelStatus: { type: "string", required: true },
          memAvailableMB: { type: "number", required: true },
          error: { type: "string", required: true },
        },
      },
      render: renderJson,
    },
    async execute() {
      // 主动装回也跟随会话：会话在本地模型上 ⇒ 装它；路由不可判定/在云端 ⇒ 退回 config.model（旧行为）
      const r = await warmModel({ ...cfg, model: localTarget(cfg) || cfg.model });
      const mem = await memInfo();
      if (r.ok === true) await clearPending();   // 主动装回 ⇒ 待回归标记一并了结
      return {
        ok: r.ok === true,
        modelStatus: String(r.status ?? "unknown"),
        memAvailableMB: mem.memAvailableMB,
        error: String(r.error ?? ""),
      };
    },
  })));

  ctx.effect(() => () => { for (const d of disposers) { try { d(); } catch { /* noop */ } } }, "self-recall: dispose tools");
}
