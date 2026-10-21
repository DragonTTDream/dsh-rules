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
import { mkdir, writeFile, access, unlink, readFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { spawn, spawnSync } from "node:child_process";
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
  endpoint: "",   // 填你自己的本地推理端点，如 "http://127.0.0.1:8080"
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
async function unloadTarget(cfg) {
  const t = localTarget(cfg);
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
export function markerIn(file) {
  try { const hit = readFileSync(file, "utf8").match(/marker=(\S+)/); return hit ? hit[1] : ""; }
  catch { return ""; }
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
        "- 提交这类任务只用 `arbitrate_run`：卸载模型 → setsid 后台启动脚本 → 轮询 marker → 返回结果。工具调用期间回合保持打开，返回时模型被按需装载、会话自动召回，无需用户发起对话。**装卸对象 = 本会话当前用的那个本地模型**（按会话路由解析，`config.localModels` 内任一命中即用；跟随你会话里选的纯文本/弹性条目，不写死一条）。",
        "- `arbitrate_run` 在 marker 到手后自动回归：先卸 config.auxModels（谁卸谁）再发 1 token 预热主模型（返回 `warmMs`/`warmOk`），provider 装载的 30–45 秒吃在工具调用里，用户下一条消息直接命中热模型；连续跑重活时传 `warm:false` 省这段时间。",
        "- **待回归兜底（插件保证，不靠自觉，四层闭环）**：`arbitrate_run` 卸载成功即落盘 pending 标记。**① 任务脚本自带回归**（插件在脚本头部注入 EXIT trap：任务一退出就卸 auxModels 并发 1 token 装回主模型，与 harness 是否放弃这次调用无关）；**② 插件定时器**每 `pendingScanMs` 毫秒检查 pending，任务进程已退出就补 warm（会话空闲无请求也照跑）；**③ 回合开始前**（`agent/pre-step`）检查 pending 补 warm；**④ 超时分支**补判迟到 marker 与任务进程状态。**任务进程还在跑时四层全部绝不装回**（串行独占不破）。`arbitrate_warm` 成功也会清掉标记。",
        "- 任务脚本必须写 marker（成功和失败都要写，格式 `marker=<值>`），否则调用方只能干等到超时。**脚本不要 `exec` 重定向自己的 stdout** —— 插件已把 stdout 接进 job.log，抢走 stdout 会让 marker 永远读不到（2026-10-14 实测踩过）。",
        `- 跑重活前后用 \`arbitrate_status\` 看红线：MemAvailable ≥${freeGB}GB 自由跑；≥${floorGB}GB 降级并不碰模型；低于它才卸载。始终为用户保留 ≥${floorGB}GB 轻量办公余量。`,
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
    description: "串行执行一个需要大内存的后台任务：卸载本地模型 → setsid 后台启动脚本 → 轮询 marker → 返回结果。工具调用期间回合保持打开，返回时模型被按需装载、会话自动召回。脚本必须自己写 marker（成功和失败都要写，格式 marker=<值>）。marker 到手后自动回归：先卸 config.auxModels（谁卸谁）再发 1 token 预热主模型，把 provider 装载耗时吃在本调用里（见 warmMs/warmOk），用户下一条消息直接命中热模型。禁止在脚本里加看门狗杀 llama-swap 子进程。",
    parameters: {
      script: { type: "string", required: true, description: "要执行的 bash 脚本内容。约定：结束时 echo 'marker=<值>'。" },
      label: { type: "string", description: "短标签，用于命名工作目录（默认 job）。" },
      timeoutSec: { type: "number", description: "最长等待秒数，默认 900，上限 3600。" },
      unload: { type: "boolean", description: "是否先卸载模型，默认 true。" },
      warm: { type: "boolean", description: "任务结束后是否自动回归并预热：先按「谁卸谁」卸掉 config.auxModels，再发 1 token 请求触发 provider 装载，把装载耗时吃在本工具调用里。默认取 config.warmAfterRun；马上还要接着跑重活时传 false。" },
    },
    output: {
      schema: {
        type: "object",
        additionalProperties: false,
        properties: {
          marker: { type: "string", required: true, description: "脚本写出的 marker；空串表示没等到。" },
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
        },
      },
      render: renderJson,
    },
    async execute({ script, label, timeoutSec, unload, warm }) {
      const cap = Math.min(Math.max(Number(timeoutSec) || 900, 30), 3600);
      const tag = String(label || "job").replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 24) || "job";
      const dir = join(tmpdir(), `arbitrate-${tag}-${Date.now()}`);
      await mkdir(dir, { recursive: true });
      const before = await memInfo();
      // 卸谁（2026-10-16）：会话命中的本地模型 → 否则端点正在跑的本地模型 → 否则 config.model。不再写死 cfg.model。
      const target = await unloadTarget(cfg);
      const un = unload === false ? { ok: true, body: "skipped" } : await unloadModel({ ...cfg, model: target });
      const sh = join(dir, "job.sh");
      const out = join(dir, "job.log");
      // 只有真的卸过才欠一次回归——unload=false（同模型不卸）时模型没走，不写标记
      if (unload !== false && cfg.pendingWarm && un.ok) await writePending({ dir, out, label: tag, model: target, route: lastRoute });
      // R5：把回归写进任务脚本本身（EXIT trap），任务进程脱离会话 ⇒ 与 harness 是否放弃调用无关
      const doWarmFlag = warm === false ? false : (warm === true ? true : cfg.warmAfterRun);
      const body = typeof script === "string" ? script : "";
      await writeFile(sh, cfg.warmSelfScript && doWarmFlag ? selfWarmSnippet(cfg, target) + body : body, "utf8");
      // 单一启动路径：setsid 脱离会话 + 重定向，detached 后 unref，绝不随会话退出
      const runner = spawn("bash", ["-c", `setsid bash ${JSON.stringify(sh)} </dev/null > ${JSON.stringify(out)} 2>&1 &`], {
        cwd: dir,
        detached: true,
        stdio: "ignore",
        env: { ...process.env, SELF_RECALL_WARM: doWarmFlag && (!cfg.warmOnlyLocalSession || routeIsLocal(cfg)) ? "1" : "0" },
      });
      runner.unref?.();
      const t0 = Date.now();
      let marker = "", tail = "";
      while (Date.now() - t0 < cap * 1000) {
        await sleep(10000);
        try {
          const { readFileSync } = await import("node:fs");
          const text = readFileSync(out, "utf8");
          tail = text.split("\n").slice(-40).join("\n");
          const hit = text.match(/marker=(\S+)/);
          if (hit) { marker = hit[1]; break; }
        } catch { /* 日志还没生成 */ }
      }
      // ── 自动回归 + 预热 ─────────────────────────────────────────────
      // 只在 marker 到手后做：marker 没等到 ⇒ 任务可能还在后台跑，此时装回模型 = 违反串行独占。
      // 顺序硬要求：先按「谁卸谁」卸掉重活拉起的辅助模型，再 warm 主模型（辅助模型在场时装主模型会 OOM）。
      let wr = { skipped: true, ms: 0, ok: false };
      const doWarm = doWarmFlag;
      const warmNow = async (why) => {
        if (cfg.warmOnlyLocalSession && !routeIsLocal(cfg)) {
          await clearPending();
          log?.warn?.(`self-recall: 跳过回归预热(${why}) — 调用方会话路由 "${lastRoute?.model ?? "?"}" 不在本地模型表 [${localModels(cfg).join(", ")}]`);
          return { skipped: true, ms: 0, ok: false };
        }
        // 任务脚本自己已经回归（R5 的 EXIT trap 发过 1 token）⇒ 不重复装载，只清 pending
        if (selfWarmCode(out) === "200") {
          await clearPending();
          log?.warn?.("self-recall: 任务脚本已自行回归（self-recall-warm=200）⇒ 跳过重复装载");
          return { skipped: true, ms: 0, ok: true };
        }
        for (const m of cfg.auxModels) {
          const u = await unloadModel({ ...cfg, model: m });
          if (!u.ok) log?.warn?.(`self-recall: aux unload "${m}" failed: ${u.body}`);
        }
        const tw = Date.now();
        const w = await warmModel({ ...cfg, model: target });
        const r = { skipped: false, ms: Math.round((Date.now() - tw) / 1000), ok: w.ok === true };
        if (w.ok === true) await clearPending();
        else log?.warn?.(`self-recall: warm failed(${why}): ${w.error ?? "unknown"}（请求驱动的召回链照旧保底，pending 保留）`);
        return r;
      };
      if (doWarm && marker !== "") {
        wr = await warmNow("marker");
      } else if (doWarm && marker === "") {
        // R2：超时 ≠ 任务没完。marker 后到 或 任务进程已退出 ⇒ 当场补 warm，不留离线态；
        //      任务确实还在跑 ⇒ 绝不装回（串行独占），把回归交给 agent/pre-step 的 pending 兜底。
        const late = markerIn(out);
        if (late !== "") marker = late;
        if (late !== "" || !jobAlive(dir)) wr = await warmNow("timeout+job-done");
        else log?.warn?.("self-recall: 超时且任务仍在跑 ⇒ 不装回，pending 交由 agent/pre-step 兜底");
      }
      const after = await memInfo();
      return {
        marker,
        timedOut: marker === "",
        elapsedSec: Math.round((Date.now() - t0) / 1000),
        unloadOk: un.ok === true,
        unloadBody: String(un.body ?? ""),
        memBeforeMB: before.memAvailableMB,
        memAfterMB: after.memAvailableMB,
        logTail: tail,
        workdir: dir,
        warmMs: wr.ms,
        warmOk: wr.ok,
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
