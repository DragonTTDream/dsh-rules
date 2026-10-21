/**
 * dsh-vision-forward — 视觉带外转发
 *
 * 三条道（config 选路，probe=true 一律退回只观察）：
 *  1) 转录道 transcribe=true（主路）：agent/pre-step 内开离线窗口做真 OCR，图块换成逐字文本。
 *     窗口只在 pre-step 跑——那时本次请求还不存在，卸主模型才安全。
 *  2) 占位道 replace=true：pre-step 把图块换成"未转录"占位文本，指向 vision 工具。
 *  3) vision 工具：主模型传绝对路径 ⇒ 插件开窗口（卸主 → 视觉出结果 → 卸视觉 → 装回主）⇒ 返回文本。
 *
 * llm/stream 监听器**只做改道**（孪生条目 twin → 真主模型），不在里面卸模型：
 * 它运行在"目标就是主模型的那次请求"的 waterfall 内部，在那里卸主模型 = 把承载本次请求的模型从脚下抽走。
 * 两个监听器全程 try/catch，异常一律交回 next()/decision ⇒ 插件不可能弄坏对话。
 *
 * 本机事实（endpoint / 模型名 / 路径）全部走 config，源码保持 provider 零知识。
 */

import { defineTool } from "@deepseek-ai/dsh-tools";
import { resolveImageAttachmentAccess } from "@deepseek-ai/dsh-llm";
import z from "@deepseek-ai/schemastery";
import { appendFileSync, readFileSync, statSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { extname, resolve } from "node:path";

export const name = "vision-forward";
// inject 必须列全插件体内访问的每一个服务：cordis 的 ctx 代理是「访问属性时才解析服务」，
// 名字不在 inject 里就抛 `cannot get property "llm" without inject`（cordis/lib/index.js:676）。
// 抛点在 llm/stream 全局 waterfall 内 ⇒ 宿主进程 fatal load failure 退出 ⇒ 所有模型（含云端）对话全崩。
// 访问点：ctx.tools(注册 vision 工具) / ctx.llm.stream(改道短路) / ctx.attachments(取图片附件字节)。
export const inject = ["tools", "llm", "attachments", "sessionProjections"];

// 官方写法：export const Config = z.object({...})（本机实测 69 处官方包同款）。
// 加载器会按它校验 patch 里的 config（cordis/lib/types/registry.d.ts:116 "validated against its Config schema"）。
// 全部键可选：缺哪个由下方 DEFAULTS 兜，代码行为不变；写错键名/类型当场报，不用等运行时猜。
export const Config = z.object({
  probe: z.boolean(),
  logImages: z.boolean(),
  replace: z.boolean(),
  transcribe: z.boolean(),
  logFile: z.string(),
  endpoint: z.string(),
  twinModel: z.string(),
  mainProvider: z.string(),
  mainModel: z.string(),
  ocrModel: z.string(),
  vlmModel: z.string(),
  statusPath: z.string(),
  unloadPath: z.string(),
  warmAfterRun: z.boolean(),
  requestTimeoutSec: z.number().min(10).step(1),
  maxTokens: z.number().min(1).step(1),
  maxImageMB: z.number().min(1).step(1),
  vramFreeTargetMB: z.number().min(0).step(1),
  vramWaitMs: z.number().min(1000).step(1),
  nativeVisionModels: z.array(z.string()),
});

const DEFAULTS = {
  probe: true,        // 总回退开关：true ⇒ 只观察，不替换不转录
  logImages: true,
  replace: false,     // 占位道：image → 占位 text（未接 OCR 不伪造转录）
  transcribe: false,  // 转录道（主路）：pre-step 内开离线窗口做真转录，图块换成逐字文本
  logFile: "",        // 装载心跳与事件自证（宿主 journal 里插件行不可见）
  endpoint: "",   // 填你自己的本地推理端点，如 "http://127.0.0.1:8080"
  twinModel: "",      // 孪生条目 id（声明 input:[text,image]，界面才收图）；llm/stream 见到它就改道
  mainProvider: "",   // 真主模型所在 provider 路由名（改道时用）
  mainModel: "",      // 会话主模型（窗口开始前卸它）
  ocrModel: "",       // 逐字转录（默认道）
  vlmModel: "",       // 理解/推理（判据升级道）
  statusPath: "/v1/models",
  unloadPath: "/api/models/unload",
  warmAfterRun: true,
  requestTimeoutSec: 300,
  maxTokens: 8192,
  maxImageMB: 8,
  vramFreeTargetMB: 2048,   // 卸主模型后等显存回落到这个值（MiB）以下再调视觉模型
  vramWaitMs: 30000,        // 显存等待上限
  nativeVisionModels: [],   // 原生识图条目 id 清单 ⇒ vision 工具在这些会话直接拒绝（图原生进上下文，调工具纯浪费）
};

const MEDIA = { ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp", ".gif": "image/gif" };

function num(v, fb, min) { const n = Number(v); return Number.isFinite(n) && n >= min ? Math.floor(n) : fb; }
function str(v, fb) { return typeof v === "string" && v.length > 0 ? v : fb; }

function fileLog(path, line) {
  if (!path) return;
  try { appendFileSync(path, `${new Date().toISOString()} ${line}\n`); }
  catch { /* 日志写不进不影响功能 */ }
}

async function memInfo() {
  try {
    const t = readFileSync("/proc/meminfo", "utf8");
    const a = Number((t.match(/MemAvailable:\s+(\d+) kB/) || [])[1] || 0);
    const sf = Number((t.match(/SwapFree:\s+(\d+) kB/) || [])[1] || 0);
    return { memAvailableMB: Math.round(a / 1024), swapFreeMB: Math.round(sf / 1024) };
  } catch { return { memAvailableMB: -1, swapFreeMB: -1 }; }
}

async function httpJson(cfg, path, body, method, timeoutMs) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs ?? cfg.requestTimeoutSec * 1000);
  try {
    const r = await fetch(cfg.endpoint + path, {
      method: body ? "POST" : (method || "GET"),
      headers: { "Content-Type": "application/json" },
      body: body ? JSON.stringify(body) : undefined,
      signal: ctrl.signal,
    });
    return { status: r.status, text: await r.text() };
  } catch (e) {
    return { status: 0, text: `ERR ${e?.name}: ${e?.message}` };
  } finally { clearTimeout(t); }
}

async function modelStatus(cfg, model) {
  const r = await httpJson(cfg, cfg.statusPath, null, "GET", 25000);
  try {
    const d = JSON.parse(r.text);
    const hit = (d?.data || []).find((x) => x?.id === model);
    return String(hit?.status?.value ?? "absent");
  } catch { return "unknown"; }
}

async function unloadModel(cfg, model) {
  if (!model) return { ok: true, body: "skipped(no model)" };
  const r = await httpJson(cfg, `${cfg.unloadPath}/${encodeURIComponent(model)}`, {}, "POST", 60000);
  return { ok: r.status >= 200 && r.status < 300, body: r.text.slice(0, 200) };
}

/**
 * 当前显存占用（MiB）。取不到返回 undefined（不动 nvidia-smi 的机器不该因此失败）。
 */
function gpuUsedMB() {
  try {
    const out = execFileSync(cfg_nvidiaSmi(), ["--query-gpu=memory.used", "--format=csv,noheader,nounits"],
      { timeout: 5000, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
    const n = Number(String(out).trim().split("\n")[0]);
    return Number.isFinite(n) ? n : undefined;
  } catch { return undefined; }
}
function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }
function cfg_nvidiaSmi() { return process.env.VF_NVIDIA_SMI || "/usr/bin/nvidia-smi"; }

/**
 * 等显存**真的**释放再调视觉模型。
 * ⚠ 为什么必须有：`POST /api/models/unload/<m>` 返回 200 ≠ 显存已释放（实测偶发 10 ms 就返回）。
 * 2026-10-13 实测后果：`mode=understand` 走 27B（11.4 GB + 0.9 GB mmproj）时立刻去装载 ⇒
 * `cudaMalloc failed: out of memory` + `GGML_ASSERT(buffer) failed` ⇒ HTTP 500 `upstream command exited prematurely`。
 * 判据 = 轮询显存回落到 `vramFreeTargetMB` 以下；nvidia-smi 不可用时退化为固定 settle 等待。
 */
async function waitVramFree(cfg, log) {
  const t0 = Date.now();
  const target = cfg.vramFreeTargetMB;
  let last;
  while (Date.now() - t0 < cfg.vramWaitMs) {
    last = gpuUsedMB();
    if (last === undefined) { await sleep(2000); return { ok: true, usedMB: undefined, waitedMs: Date.now() - t0, note: "no-nvidia-smi" }; }
    if (last <= target) return { ok: true, usedMB: last, waitedMs: Date.now() - t0 };
    await sleep(400);
  }
  const line = `vision-forward[VRAM-TIMEOUT] 等 ${cfg.vramWaitMs} ms 后显存仍 ${last} MiB（目标 ≤${target}）`;
  log?.warn?.(line); fileLog(cfg.logFile, line);
  return { ok: false, usedMB: last, waitedMs: Date.now() - t0 };
}

async function warmModel(cfg) {
  const r = await httpJson(cfg, "/v1/chat/completions", {
    model: cfg.mainModel, messages: [{ role: "user", content: "ok" }], max_tokens: 1, stream: false,
  }, "POST", cfg.requestTimeoutSec * 1000);
  const ok = r.status === 200;
  return { ok, status: ok ? "loaded" : `http ${r.status}`, error: ok ? "" : r.text.slice(0, 200) };
}

function partsOf(m) {
  const c = m?.content;
  if (Array.isArray(c)) return c;
  if (typeof c === "string") return [{ type: "text", text: c }];
  return c ? [c] : [];
}

function shapeOf(p) {
  return {
    type: p?.type,
    keys: Object.keys(p ?? {}),
    mediaType: p?.mediaType,
    dataLen: typeof p?.data === "string" ? p.data.length : undefined,
    hasAttachment: !!p?.attachment,
  };
}

function collectImages(msgs) {
  const out = [];
  for (const m of msgs) for (const p of partsOf(m)) if (p?.type === "image") out.push(p);
  return out;
}

/**
 * 图片的稳定身份键（去重转录用）。
 * 为什么不按「本轮新消息」判：harness 每步都把**整段会话历史**重新交给 pre-step，
 * 历史里的 image 块每步都在 ⇒ 不按身份去重就会「每一步重开一次离线窗口」（2026-10-13 实测的 CPU 反复高占用根因）。
 * 键取自附件引用本身（attachmentId + mediaType + bytes），不取 base64，避免大字符串参与哈希。
 */
function imageKey(p) {
  const a = p?.attachment ?? {};
  const id = a.attachmentId ?? p?.mediaType ?? "?";
  const bytes = a.bytes ?? (typeof p?.data === "string" ? p.data.length : "?");
  return `${id}|${a.mediaType ?? p?.mediaType ?? "?"}|${bytes}`;
}

// P1：只换 image part，文字与其余 part 原样保留。文本如实说明"占位、未转录"，并指向 vision 工具。
function replaceImages(msgs) {
  let n = 0;
  const out = msgs.map((m) => {
    const parts = Array.isArray(m?.content) ? m.content : [m?.content];
    const np = parts.map((p) => {
      if (p?.type !== "image") return p;
      n += 1;
      const kb = typeof p.data === "string" ? Math.round((p.data.length * 3) / 4 / 1024) : undefined;
      return {
        type: "text",
        text: `【图片已由 vision-forward 插件接管（占位，未转录）。mediaType=${p.mediaType ?? "未知"}，` +
          `${kb === undefined ? "尺寸未知" : `约 ${kb} KiB`}。需要图里的信息请调用 vision 工具（传图片文件绝对路径），` +
          `不要声称看到了图中内容。】`,
      };
    });
    if (!Array.isArray(m?.content) && typeof m?.content === "string") {
      return { ...m, content: np.length === 1 ? np[0].text : np.map((x) => x?.text ?? "").join("\n") };
    }
    return { ...m, content: np };
  });
  return { out, n };
}

// 转录道：把 image part 换成「真转录文本」。
// texts 按本次新图片出现顺序对齐；textsByKey 是历史图片的转录缓存（同一附件不重复开窗口）。
function replaceImagesWith(msgs, texts, ocrName, textsByKey) {
  let i = 0, n = 0, cached = 0;
  const out = msgs.map((m) => {
    const parts = Array.isArray(m?.content) ? m.content : [m?.content];
    const np = parts.map((p) => {
      if (p?.type !== "image") return p;
      n += 1;
      const hit = textsByKey?.get?.(imageKey(p));
      let t;
      if (hit !== undefined) { t = hit; cached += 1; }
      else t = texts[i++] ?? "(图片转录缺失)";
      return { type: "text", text: `【图片已由 vision-forward 带外逐字转录（${ocrName}）】\n${t}` };
    });
    if (!Array.isArray(m?.content) && typeof m?.content === "string") {
      return { ...m, content: np.length === 1 ? np[0].text : np.map((x) => x?.text ?? "").join("\n") };
    }
    return { ...m, content: np };
  });
  return { out, n, cached };
}

/**
 * 工具输出渲染器。**必须返回 ContentBlock[]**（官方签名 `render(args, value): ContentBlock[]`，
 * 见 dsh-tools/lib/types/index.d.ts:110；官方样例 dsh-tool-bash/lib/index.js:636
 * `render: (_args, value) => [{ type: "text", text: … }]`）。
 * 2026-10-13 修：此前写成"返回一个对象"的自定义 renderJson ⇒ harness 把结果当数组调 `.some`
 * ⇒ 每次调用工具都 `Error: content.some is not a function`（该 bug 一直潜伏，直到第一次真正调用才暴露）。
 */
function renderVision(args, value) {
  const v = value ?? {};
  const head = v.ok
    ? `vision(${v.mode ?? "?"} · ${v.model ?? "?"}) 用时 ${v.elapsedSec ?? "?"}s（视觉调用 ${v.visionCallSec ?? "?"}s，装回主模型 ${Math.round((v.mainWarmMs ?? 0) / 1000)}s）`
    : `vision 失败：${v.error || "未知错误"}`;
  const body = typeof v.text === "string" && v.text.length ? v.text : "(无文本)";
  return [{ type: "text", text: `${head}\n\n${body}` }];
}

async function visionCall(cfg, model, b64, media, prompt) {
  const r = await httpJson(cfg, "/v1/chat/completions", {
    model,
    messages: [{ role: "user", content: [
      { type: "image_url", image_url: { url: `data:${media};base64,${b64}` } },
      { type: "text", text: prompt },
    ] }],
    max_tokens: cfg.maxTokens, temperature: 0, stream: false,
  }, "POST");
  if (r.status !== 200) return { text: "", error: `HTTP ${r.status}: ${r.text.slice(0, 200)}` };
  try {
    const ch = JSON.parse(r.text)?.choices?.[0]?.message;
    // C（2026-10-16）：?? 只在 null 回退，content="" 不回退 ⇒ 空串时手动兜底到 reasoning_content
    const ct = String(ch?.content ?? "").trim();
    const text = ct || String(ch?.reasoning_content ?? "").trim();
    return { text, error: text ? "" : "视觉模型返回空内容" };
  } catch { return { text: "", error: `响应解析失败: ${r.text.slice(0, 200)}` }; }
}

function collectRequestImages(messages) {
  const out = [];
  for (const m of messages ?? []) {
    const c = m?.content;
    if (Array.isArray(c)) for (const p of c) if (p?.type === "image") out.push(p);
  }
  return out;
}

/**
 * 改道流：twin → 真主模型。**同步调用的 async generator**（官方形态，dsh-llm/lib/invariant.js:19,63）。
 * 监听器同步返回本函数的生成器对象 ⇒ 下游 `yield*` 拿到的是 async iterable，不是 Promise。
 * 异步工作（改道、日志）发生在被消费时。任何异常 ⇒ 就地交还真适配器 next() 的流，插件不可能弄坏对话。
 */
async function* routeStream(cfg, ctx, options, next, log) {
  const t0 = Date.now();
  try {
    // ⚠ 只换 **image part**（:234 起是本轮改的关键修复）：
    //    v1 无条件给每个 part 写占位文本 ⇒ pre-step 已经写好的**逐字转录被原地抹掉**，
    //    主模型拿回的是"未转录"占位（01:54 现场：leftoverImages=2 且回复无内容）。
    //    现在：text part 原样保留（那是转录），只有真 image part 才降级为占位。
    const leftover = collectRequestImages(options?.messages);
    const messages = (options.messages ?? []).map((m) => {
      const c = m?.content;
      if (!Array.isArray(c)) return m;
      let touched = false;
      const np = c.map((p) => {
        if (p?.type !== "image") return p;
        touched = true;
        return { type: "text", text: "【图片未转录（插件转录道未启用或转录未执行）。需要图里的信息请调用 vision 工具（传图片文件绝对路径）。】" };
      });
      return touched ? { ...m, content: np } : m;
    });
    const line = `vision-forward[ROUTE] ${cfg.twinModel}→${cfg.mainModel} leftoverImages=${leftover.length}`;
    log?.info?.(line); fileLog(cfg.logFile, line);
    const s = ctx.llm.stream({
      ...options,
      provider: cfg.mainProvider || options.provider,
      model: cfg.mainModel,
      messages,
    });
    if (!s || typeof s[Symbol.asyncIterator] !== "function") {
      fileLog(cfg.logFile, "vision-forward[ROUTE] 改道流不可迭代 ⇒ 交还真适配器");
      const fb = next();
      if (fb && typeof fb[Symbol.asyncIterator] === "function") { yield* fb; return; }
      return;
    }
    yield* s;
    fileLog(cfg.logFile, `vision-forward[ROUTE-END] ms=${Date.now() - t0}`);
  } catch (e) {
    const line = `vision-forward[ROUTE-FAIL] 异常兜底 → 真适配器: ${e?.message ?? e} ms=${Date.now() - t0}`;
    log?.warn?.(line); fileLog(cfg.logFile, line);
    try {
      const fb = next();
      if (fb && typeof fb[Symbol.asyncIterator] === "function") yield* fb;
    } catch { /* 真适配器也失败：让上游按原生路径处理 */ }
  }
}

// ── 离线窗口（只在 pre-step 调用：那时请求还不存在，卸主模型是安全的）──────
// 卸主模型 → 逐图转录 → 卸视觉模型 → 装回主模型。谁卸谁；httpJson 已兜底，本函数不抛。
async function runWindow(cfg, ctx, images) {
  const t0 = Date.now();
  const mem = await memInfo();
  const texts = [];
  const errs = [];
  const un = await unloadModel(cfg, cfg.mainModel);
  if (!un.ok) errs.push(`卸主模型失败: ${un.body}`);
  const vram = await waitVramFree(cfg, ctx.logger);   // 等显存真释放（卸载 API 返回 ≠ 显存已还）
  for (const p of images) {
    let path = "";
    try {
      // VF_TEST_RESOLVE 只服务离线回归测试（生产不设该环境变量 ⇒ 走真解析器，零影响）。
      const resolver = process.env.VF_TEST_RESOLVE
        ? (await import(process.env.VF_TEST_RESOLVE)).resolveImageAttachmentAccess
        : resolveImageAttachmentAccess;
      path = resolver(ctx.attachments, (x) => x, p.attachment)?.readonlyPath ?? "";
    }
    catch (e) { texts.push("(图片附件不可读)"); errs.push(`附件解析: ${e?.message ?? e}`); continue; }
    if (!path) { texts.push("(图片附件不可读)"); continue; }
    let b64 = "";
    try { b64 = readFileSync(path).toString("base64"); }
    catch (e) { texts.push("(读图失败)"); errs.push(`读图: ${e?.message ?? e}`); continue; }
    const media = MEDIA[extname(path).toLowerCase()] || "image/png";
    const r = await visionCall(cfg, cfg.ocrModel, b64, media, "OCR:");
    if (r.error) errs.push(r.error);
    texts.push(r.text || `(转录失败: ${r.error})`);
  }
  const uv = await unloadModel(cfg, cfg.ocrModel);
  if (!uv.ok) errs.push(`卸视觉模型失败: ${uv.body}`);
  let warm = { ok: true, ms: 0 };
  if (cfg.warmAfterRun) {
    const tw = Date.now();
    const w = await warmModel(cfg);
    warm = { ok: w.ok === true, ms: Date.now() - tw };
    if (!warm.ok) errs.push(`装回主模型失败: ${w.error}`);
  }
  return { texts, errs, windowMs: Date.now() - t0, mem, warmOk: warm.ok, warmMs: warm.ms };
}

/**
 * 取「本次会话**当前选中的模型**」。
 * ⚠ 千万别用 `agent.options.model`：那是 agent **创建时**的模型（默认模型），不是会话当前选择——
 * 2026-10-13 实测：会话已选孪生条目，`agent.options.model` 仍是 `deepseek-flash`，护栏据此把正常请求全拦了。
 * 正确来源（与 harness 自己的图片准入闸同一处）：`sessionProjections.stateOf(session,"modelSelection")`。
 * 三级回退：投影 → 会话最近请求头 → agent 创建模型；都取不到返回 undefined（由调用方决定安全侧）。
 */
function sessionModelOf(ctx, agent) {
  try {
    const st = ctx?.sessionProjections?.stateOf?.(agent?.session, "modelSelection");
    const pick = st?.pending ?? st?.lastUsed;
    if (pick?.model) return String(pick.model);
  } catch { /* 投影不可用则继续回退 */ }
  try {
    const h = agent?.session?.requestHeader?.();
    if (h?.config?.model) return String(h.config.model);
  } catch { /* 同上 */ }
  const fallback = agent?.options?.model;
  return typeof fallback === "string" && fallback ? fallback : undefined;
}

export function apply(ctx, config = {}) {
  const log = ctx.logger;
  const cfg = {
    probe: config.probe !== false,
    logImages: config.logImages !== false,
    replace: config.replace === true,
    transcribe: config.transcribe === true,
    logFile: str(config.logFile, DEFAULTS.logFile),
    endpoint: str(config.endpoint, DEFAULTS.endpoint).replace(/\/+$/, ""),
    twinModel: str(config.twinModel, DEFAULTS.twinModel),
    mainProvider: str(config.mainProvider, DEFAULTS.mainProvider),
    mainModel: str(config.mainModel, DEFAULTS.mainModel),
    ocrModel: str(config.ocrModel, DEFAULTS.ocrModel),
    vlmModel: str(config.vlmModel, DEFAULTS.vlmModel),
    statusPath: str(config.statusPath, DEFAULTS.statusPath),
    unloadPath: str(config.unloadPath, DEFAULTS.unloadPath),
    warmAfterRun: config.warmAfterRun !== false,
    requestTimeoutSec: num(config.requestTimeoutSec, DEFAULTS.requestTimeoutSec, 10),
    maxTokens: num(config.maxTokens, DEFAULTS.maxTokens, 1),
    maxImageMB: num(config.maxImageMB, DEFAULTS.maxImageMB, 1),
    // 显存闸门（2026-10-13 修 27B understand OOM）：等显存回落到目标值以下再调视觉模型
    vramFreeTargetMB: num(config.vramFreeTargetMB, DEFAULTS.vramFreeTargetMB, 0),
    vramWaitMs: num(config.vramWaitMs, DEFAULTS.vramWaitMs, 1000),
    nativeVisionModels: Array.isArray(config.nativeVisionModels) ? config.nativeVisionModels.map(String) : DEFAULTS.nativeVisionModels,
  };
  const replace = !cfg.probe && cfg.replace;
  const transcribe = !cfg.probe && cfg.transcribe;
  const disposers = [];
  /**
   * 转录缓存（按图片身份键）。**去重是硬要求**：harness 每步把整段会话历史交给 pre-step，
   * 历史里的图每步都在；少了这张表，每一步都会重开一次 48 秒离线窗口
   * （= 用户报的"CPU 反复高占用、回答变慢、难道每次思考都在重新识图"——2026-10-13 实测确认）。
   */
  const transcribeCache = new Map();

  // ── pre-step：观察 / 转录 / 占位（离线窗口在这里跑：那时请求还不存在，卸主模型才安全）──
  disposers.push(ctx.on("agent/pre-step", async (payload, next) => {
    const msgs = Array.isArray(payload?.messages) ? payload.messages : [];
    const images = collectImages(msgs);
    // ⚠ 模型护栏（2026-10-13 修正版）：只服务**孪生条目**。会话若在**原生支持图片的模型**上
    //   （如云端 deepseek-flash / Strata 256k 视觉档），图本就该原生进去 —— 插件不得为跑本地 OCR 去卸别人的模型。
    //   取值必须走 `sessionModelOf`（会话选择投影），**不是** `agent.options.model`（那是默认模型，会把正常请求拦死，实测过）。
    const sessionModel = sessionModelOf(ctx, payload?.agent);
    if (images.length && sessionModel !== undefined && sessionModel !== cfg.twinModel) {
      const line = `vision-forward[SKIP] 会话模型=${sessionModel} ≠孪生 ${cfg.twinModel} ⇒ 原生处理图片，插件不介入`;
      log?.info?.(line); fileLog(cfg.logFile, line);
      return next();
    }
    if (images.length && sessionModel === undefined) {
      fileLog(cfg.logFile, "vision-forward[MODEL-UNKNOWN] 取不到会话模型 ⇒ 按孪生处理（本插件只为孪生条目而存在）");
    }
    if (images.length && cfg.logImages) {
      const line = `vision-forward[P0] turn=${payload?.turn} step=${payload?.step} msgs=${msgs.length} images=${images.length} ` +
        `mode=${transcribe ? "transcribe" : (replace ? "placeholder" : "observe")} shape=${JSON.stringify(images.map(shapeOf))}`;
      log?.info?.(line); fileLog(cfg.logFile, line);
    }
    const decision = await next();
    if (!images.length) return decision;
    const base = decision?.kind === "enter" && Array.isArray(decision.messages) ? decision.messages : msgs;
    const tail = decision?.startsRequestSeries ? { startsRequestSeries: true } : {};

    if (transcribe) {
      // ① 先分区：历史图（已转录）与新图（要开窗口）。
      const fresh = [], freshKeys = [], cachedHits = [];
      for (const p of images) {
        const k = imageKey(p);
        const hit = transcribeCache.get(k);
        if (hit !== undefined) { cachedHits.push([k, hit]); }
        else if (!freshKeys.includes(k)) { fresh.push(p); freshKeys.push(k); }
      }
      // ② 全为历史图 ⇒ 直接用缓存替换，**一步都不碰模型**（这就是"不再每步重新识图"）。
      if (!fresh.length) {
        const { out, n } = replaceImagesWith(base, [], cfg.ocrModel, new Map(cachedHits));
        const line = `vision-forward[WINDOW-SKIP] 全部 ${n} 图命中转录缓存 ⇒ 零窗口（warmOk=true windowMs=0）`;
        log?.info?.(line); fileLog(cfg.logFile, line);
        return n ? { kind: "enter", messages: out, ...tail } : decision;
      }
      try {
        const w = await runWindow(cfg, ctx, fresh);
        freshKeys.forEach((k, i) => {
          const t = w.texts[i];
          if (typeof t === "string" && t.length) transcribeCache.set(k, t);
        });
        const { out, n, cached } = replaceImagesWith(base, w.texts, cfg.ocrModel, new Map(cachedHits));
        const line = `vision-forward[WINDOW] 转录 ${n} 图（新 ${fresh.length} / 缓存命中 ${cached}）windowMs=${w.windowMs} warmOk=${w.warmOk} ` +
          `memBeforeMB=${w.mem.memAvailableMB} errs=${w.errs.join("; ") || "无"}`;
        log?.info?.(line); fileLog(cfg.logFile, line);
        if (n) return { kind: "enter", messages: out, ...tail };
        return decision;
      } catch (e) {
        const line = `vision-forward[WINDOW-FAIL] 窗口异常 → 退回占位道: ${e?.message ?? e}`;
        log?.warn?.(line); fileLog(cfg.logFile, line);
        const { out, n } = replaceImages(base);
        return n ? { kind: "enter", messages: out, ...tail } : decision;
      }
    }

    if (!replace) return decision;
    const { out, n } = replaceImages(base);
    if (!n) return decision;
    const line1 = `vision-forward[P1] 已把 ${n} 个 image part 替换为占位 text（turn=${payload?.turn} step=${payload?.step}）`;
    log?.info?.(line1); fileLog(cfg.logFile, line1);
    return { kind: "enter", messages: out, ...tail };
  }));

  // ── llm/stream：只做改道（twin → 真主模型），绝不在这里卸模型 ────────────────
  // 为什么不在这里开窗口：本监听器运行在「目标就是主模型的那次请求」的 waterfall 内部，
  // 在这里卸主模型 = 把承载本次请求的模型从脚下抽走 ⇒ 请求死 ⇒ 会话崩（第二次事故的教训）。
  //
  // ⚠ 监听器必须**同步**（第三次事故的根因）：cordis 的 waterfall 是 `return next()` 直接透传
  //   （cordis/lib/index.js:317-324），async 函数永远返回 Promise ⇒ 下游 `yield*` 一个 Promise
  //   ⇒ "yield* … is not async iterable"。官方自带监听器同款形态（dsh-llm/lib/invariant.js:63）：
  //   无 async，返回 async generator 对象。异步工作发生在被消费时，不在返回值里。
  disposers.push(ctx.on("llm/stream", (options, next) => {
    if (!cfg.twinModel || !cfg.mainModel || options?.model !== cfg.twinModel) return next();
    fileLog(cfg.logFile, `vision-forward[ROUTE-IN] model=${options.model} provider=${options.provider}`);
    return routeStream(cfg, ctx, options, next, log);
  }, { global: true }));

  // ── vision 工具：离线窗口内看图，返回文本 ─────────────────────────────
  disposers.push(ctx.tools.register(defineTool({
    name: "vision",
    description:
      "看一张本地图片文件，返回文本。插件自带离线窗口：卸主模型 → 视觉模型出结果 → 卸视觉模型 → 装回主模型并预热。" +
      "全程主模型不在场，显存与内存独占，回归耗时吃在本调用里（§53 实测：视觉调用 2.6 s + 装回主模型 41.9 s，全程 ~50 s；回归耗时取决于窗口开始前的内存余量）。" +
      "mode=ocr 走逐字转录（PaddleOCR，快、窗口小、主模型页缓存易存活）；mode=understand 走视觉推理（27B，图表读数/GUI 定位/空间理解）。" +
      "用法：用户贴图被当前会话拒绝时，把图存成文件（或让用户直接给路径），然后传绝对路径调用。一次一张，不要批量刷。" +
      "【调用前必查】当前会话模型若原生识图（条目 input 含 image，见 config.nativeVisionModels）⇒ 图原生进上下文，直接读，禁止调本工具；本工具只对纯文本会话模型有意义（会卸主模型换专用模型，数十秒装卸）。",
    parameters: {
      path: { type: "string", required: true, description: "图片文件绝对路径（png/jpg/jpeg/webp/gif）。" },
      question: { type: "string", description: "要问的问题。mode=ocr 时留空即纯逐字转录。" },
      mode: { type: "string", description: "ocr（默认，逐字转录）或 understand（视觉推理）。" },
    },
    output: {
      schema: {
        type: "object",
        additionalProperties: false,
        properties: {
          ok: { type: "boolean", required: true },
          text: { type: "string", required: true, description: "视觉模型输出的文本（转录或回答）。" },
          model: { type: "string", required: true, description: "实际使用的视觉 profile。" },
          mode: { type: "string", required: true },
          elapsedSec: { type: "number", required: true, description: "整窗口耗时（含回归）。" },
          visionCallSec: { type: "number", required: true, description: "视觉调用本身耗时。" },
          mainUnloadOk: { type: "boolean", required: true },
          mainWarmMs: { type: "number", required: true, description: "装回主模型+预热耗时；未做为 0。" },
          mainWarmOk: { type: "boolean", required: true },
          memBeforeMB: { type: "number", required: true },
          memAfterMB: { type: "number", required: true },
          error: { type: "string", required: true },
        },
      },
      render: renderVision,
    },
    async execute({ path, question, mode }, exec) {
      const t0 = Date.now();
      const useMode = mode === "understand" ? "understand" : "ocr";
      const model = useMode === "understand" ? cfg.vlmModel : cfg.ocrModel;
      const fail = (msg) => ({
        ok: false, text: "", model, mode: useMode,
        elapsedSec: Math.round((Date.now() - t0) / 1000), visionCallSec: 0,
        mainUnloadOk: false, mainWarmMs: 0, mainWarmOk: false,
        memBeforeMB: -1, memAfterMB: -1, error: msg,
      });
      if (!model) return fail(`config 未设 ${useMode === "understand" ? "vlmModel" : "ocrModel"}`);
      if (!cfg.mainModel) return fail("config 未设 mainModel");
      // 护栏（2026-10-17 用户令，纪律长在插件身上）：会话模型原生识图 ⇒ 图原生进上下文，
      // 调本工具 = 卸主模型换专用模型纯浪费 ⇒ 拒绝，并把正确做法写进拒绝消息（拒绝是路标不是墙）。
      const sm = sessionModelOf(ctx, exec?.agent);
      if (sm && cfg.nativeVisionModels.includes(sm)) {
        fileLog(cfg.logFile, `vision-forward[GUARD] 会话模型=${sm} 原生识图 ⇒ 拒绝 vision 调用`);
        return fail(`会话模型 ${sm} 原生识图（input 含 image）⇒ 图原生进上下文，直接读图即可，禁止调 vision 工具。若图未进上下文（纯文本会话），请在纯文本档会话里使用本工具。`);
      }

      let p, b64, media;
      try {
        p = resolve(String(path || ""));
        const st = statSync(p);
        if (!st.isFile()) return fail(`不是文件: ${p}`);
        if (st.size > cfg.maxImageMB * 1024 * 1024) return fail(`图片过大 ${Math.round(st.size / 1048576)} MB > ${cfg.maxImageMB} MB`);
        media = MEDIA[extname(p).toLowerCase()] || "image/png";
        b64 = readFileSync(p).toString("base64");
      } catch (e) { return fail(`读图失败 ${p}: ${e?.message ?? e}`); }

      const before = await memInfo();
      const un = await unloadModel(cfg, cfg.mainModel);   // 谁卸谁
      const vram = await waitVramFree(cfg, ctx.logger);          // 等显存真释放（否则 27B 会 cudaMalloc OOM）
      const prompt = useMode === "understand"
        ? (String(question || "").trim() || "请详细描述这张图片的内容、布局与所有可读文字。")
        : (String(question || "").trim() ? `OCR:\n${question}` : "OCR:");

      const t1 = Date.now();
      const r = await httpJson(cfg, "/v1/chat/completions", {
        model,
        messages: [{ role: "user", content: [
          { type: "image_url", image_url: { url: `data:${media};base64,${b64}` } },
          { type: "text", text: prompt },
        ] }],
        max_tokens: cfg.maxTokens, temperature: 0, stream: false,
        // A（2026-10-16）：understand 关思考直出答案（实测 56 tok/0 s vs 思考吃满 2048 出空串）
        ...(useMode === "understand" ? { chat_template_kwargs: { enable_thinking: false } } : {}),
      }, "POST");
      const visionCallSec = Math.round(((Date.now() - t1) / 1000) * 10) / 10;

      let text = "", err = "";
      if (r.status === 200) {
        try {
          const ch = JSON.parse(r.text)?.choices?.[0]?.message;
          const ct = String(ch?.content ?? "").trim();
          text = ct || String(ch?.reasoning_content ?? "").trim();
          if (!text) err = "视觉模型返回空内容";
        } catch { err = `响应解析失败: ${r.text.slice(0, 200)}`; }
      } else { err = `视觉调用 HTTP ${r.status}: ${r.text.slice(0, 200)}`; }

      const uv = await unloadModel(cfg, model);           // 谁卸谁
      if (!uv.ok) log?.warn?.(`vision-forward: 卸视觉模型 "${model}" 失败: ${uv.body}`);

      let wm = { ms: 0, ok: false };
      if (cfg.warmAfterRun) {
        const tw = Date.now();
        const w = await warmModel(cfg);
        wm = { ms: Date.now() - tw, ok: w.ok === true };
        if (!wm.ok) log?.warn?.(`vision-forward: 装回主模型失败: ${w.error}（请求驱动的召回链照旧保底）`);
      }
      const after = await memInfo();
      const line = `vision-forward[TOOL] mode=${useMode} model=${model} ok=${text !== ""} visionCallSec=${visionCallSec} ` +
        `totalSec=${Math.round((Date.now() - t0) / 1000)} warmMs=${wm.ms} warmOk=${wm.ok} path=${p} err=${err}`;
      log?.info?.(line); fileLog(cfg.logFile, line);

      return {
        ok: text !== "", text, model, mode: useMode,
        elapsedSec: Math.round((Date.now() - t0) / 1000),
        visionCallSec,
        mainUnloadOk: un.ok === true,
        mainWarmMs: wm.ms, mainWarmOk: wm.ok,
        memBeforeMB: before.memAvailableMB, memAfterMB: after.memAvailableMB,
        error: err,
      };
    },
  })));

  ctx.effect(() => () => { for (const d of disposers) { try { d(); } catch { /* noop */ } } }, "vision-forward: dispose tools");

  const banner = `vision-forward: 已装载（logImages=${cfg.logImages} mode=${transcribe ? "transcribe" : (replace ? "placeholder" : "observe")} ` +
    `probe=${cfg.probe} tool=vision route twin=${cfg.twinModel || "未设"}→${cfg.mainModel || "未设"} ocr=${cfg.ocrModel || "未设"} ` +
    `vlm=${cfg.vlmModel || "未设"} provider=${cfg.mainProvider || "未设"} logFile=${cfg.logFile || "未设"}）`;
  log?.info?.(banner);
  fileLog(cfg.logFile, banner);
}
