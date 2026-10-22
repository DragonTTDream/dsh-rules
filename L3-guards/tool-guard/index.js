/**
 * dsh-tool-guard — 把 process-shell-safety 里「可静态判定」的纪律换成硬防线
 *
 * 机制层落点（为什么这些纪律必须下沉到代码强制，见 ../deny-list.md）：
 *   ctx.tools.guard(fn)  —— 单调守卫，在所有 tools/pre-execute 监听之后求值；
 *   返回字符串即拒绝，且「监听顺序无法把拒绝翻回允许」。拒绝理由以
 *   `Error: <reason>` + isError:true 回灌模型 ⇒ 拒绝消息是路标，不是墙。
 *
 * 设计红线：
 *   1) 窄面：只判 bash / pwsh / arbitrate_run，别的全不碰（判据 2）。
 *   2) denylist 起步，allowlist 未成熟前不把 agent 锁死（判据 3）。
 *   3) 归一化后匹配：拆段 + 去反斜杠转义，堵「换行藏命令」「\\ && 转义操作符」（判据 8）。
 *      不拦 `$()` / `${}` —— 合法用法太广，误杀面大于绕过收益。
 *   4) 自身出错一律 fail-open（返回 undefined）并记日志：防线坏了不能把生产锁死。
 *   5) 命中即 fail-closed。
 *   6) 每次拒绝追加一行日志（判据 5），异步 fire-and-forget（guard 必须同步）。
 *   7) 逃生口：enabled 开关 + allowPatterns 豁免正则。
 */

import { spawnSync } from "node:child_process";
import { constants, accessSync, appendFile, appendFileSync, chmodSync, copyFileSync, existsSync, mkdir, mkdirSync, readFileSync, readdirSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import z from "@deepseek-ai/schemastery";

export const name = "tool-guard";
export const inject = ["tools"];

export const Config = z.object({
  enabled: z.boolean(),
  logFile: z.string(),
  allowPatterns: z.array(z.string()),
  disposeAllow: z.array(z.string()),
  hostServices: z.array(z.string()),
  denyDestructive: z.boolean(),
  denyBypass: z.boolean(),
  denyPkillF: z.boolean(),
  denyRestartWithBackground: z.boolean(),
  denyRestartInScript: z.boolean(),
  requireSnapshot: z.boolean(),
  autoSnapshot: z.boolean(),
  maxAutoSnapshotBytes: z.number(),
  nudgeDelegationAfter: z.number(),
  nudgeTodoAfterBash: z.number(),
  nudgeDelegationAfterReads: z.number(),
  nudgeTodoAfterMinutes: z.number(),
  requireTodoEveryMutations: z.number(),
  requireTodoEveryMinutes: z.number(),
  denyBackgroundSubagent: z.boolean(),
  denyBackgroundSubagent: z.boolean(),
  requireUserAuthForRestart: z.boolean(),
  denyUnparsableWrites: z.boolean(),
  denyParallelHeavy: z.boolean(),
  denyAskWhileAnalyzing: z.boolean(),
  denyNonAsciiPs1: z.boolean(),
  denyChainedRegistration: z.boolean(),
  denyInlineCredentials: z.boolean(),
  denySecretFileRead: z.boolean(),
  staticCheckMode: z.string(),
  staticCheckLogUntil: z.string(),
  shellcheckPath: z.string(),
  shellcheckSeverity: z.string(),
  shellcheckExclude: z.array(z.string()),
  shellcheckTimeoutMs: z.number(),
  pwshParser: z.string(),
  planFile: z.string(),
  gotchaIndex: z.string(),
  repeatDenyAt: z.number(),
  repeatWindowMinutes: z.number(),
  repeatExempt: z.string(),
  stallAt: z.number(),
  denyWritesWhilePlanDraft: z.boolean(),  snapshotSlot: z.string(),
  snapshotTargets: z.array(z.string()),
  snapshotExempt: z.array(z.string()),
});

/**
 * 日志脱敏。守卫会把命令前缀写进日志，而那里面经常带口令：
 * 实测线上日志里 `sshpass -p <口令>` 出现过 10 次，明文落盘且文件是 644。
 * 日志是排障资产，不能变成凭据泄漏面。
 */
function redact(text) {
  return String(text)
    .replace(/(\bsshpass\b[^\n]*?\s-p)\s+\S+/g, "$1 ***")
    .replace(/(--password[=\s])\S+/gi, "$1***")
    .replace(/(\b[A-Za-z_]*(?:PASSWORD|PASSWD|PASSPHRASE|SECRET|TOKEN|API_?KEY)[A-Za-z_]*=)\S+/gi, "$1***")
    .replace(/(Authorization:\s*\w+\s+)\S+/gi, "$1***");
}

export const DEFAULTS = {
  enabled: true,
  logFile: "~/.dsh/tool-guard.log",
  allowPatterns: [],
  disposeAllow: [],
  hostServices: ["dsh-web.service"],
  denyDestructive: true,
  denyBypass: true,
  denyPkillF: true,
  denyRestartWithBackground: true,
  denyRestartInScript: true,
  requireSnapshot: true,
  autoSnapshot: true,
  maxAutoSnapshotBytes: 8388608,
  nudgeDelegationAfter: 0,
  nudgeTodoAfterBash: 0,
  nudgeDelegationAfterReads: 12,
  nudgeTodoAfterMinutes: 20,
  // 2026-10-22 用户令：卡片不许"跑完再更新"。软提示无效（实测 50 次改盘只更新 1 次卡片、
  // 第 1 次还在 5 次改盘之后）⇒ 改成硬门：改盘 N 次或 M 分钟没**有效**更新卡片，就拒下一次改盘。
  requireTodoEveryMutations: 8,   // 改盘 8 次没有效更新 ⇒ 拦一次；连续两次拦不住就 fail-open 放行（不死锁）
  requireTodoEveryMinutes: 10,
  denyBackgroundSubagent: true,
  // 2026-10-22 用户令：重启等会中断生产的动作，必须由**本轮用户消息**明确授权。
  // 起因：我把某轮一次的"改完直接重启"当成常驻授权，一晚重启宿主 7–8 次。
  requireUserAuthForRestart: true,
  // 2026-10-22 用户裁决（逐字）：「解析不出动作的输入 = 缺口：既不是指令，也不是批准，也不是"继续"。」
  // 开关名：denyUnparsableWrites（= false 关掉本闸）。判据：本轮用户消息剥掉标点/符号/空白/表情后
  // 不含汉字与 ASCII 字母数字 ⇒ 本轮禁止一切改盘（write / edit / 有写盘目标的 bash）；只读调用不拦。
  // 关掉后的失效症状（本闸要防的东西，别当成"没用了"）：用户只回了「？」或「。」，模型把它读成
  //   "可以继续 / 他默许了"，于是删文件、写盘、跑改盘命令都发生了——那轮既没有指令也没有批准。
  // 关掉后的正常用法只有两种：自动续跑轮（本轮没有用户消息 ⇒ 本闸本来就放行），
  //   或本闸误杀了某类合法输入（届时按 ~/.dsh/tool-guard.log 的 DENY 行收窄判据，不要整闸关掉）。
  denyUnparsableWrites: true,
  // 本机单序列引擎：已有一个重活窗口在跑时，禁止再起 detached 重活（并行只会互相抢资源）。
  denyParallelHeavy: true,
  // 2026-10-22 用户令：他还在分析/看方案时，模型不许把方案收敛成选择题逼他拍板
  //（实测反例：用户正在权衡三条路，模型直接问「走哪条？」）
  denyAskWhileAnalyzing: true,
  // 2026-10-22 跨机执行两条硬闸。依据：社区把"不容忍例外的规则"放在 hooks / permissions / linter，
  // 不是放在 AGENTS.md（Claude Code 文档原话：Hard stops belong in settings.json permissions,
  // a linter, or a pre-commit hook）。这两条都能被一条 if 判出来 ⇒ 下沉到这里，md 只留需要人判断的。
  denyNonAsciiPs1: true,        // .ps1/.bat 含非 ASCII 且无 UTF-8 BOM ⇒ 拦（PS 5.1 按 ANSI 码页解 ⇒ 中文粘连）
  denyChainedRegistration: true, // scp/sftp 与 sc create/schtasks 串在一条 && ⇒ 拦（上游失败被静默跳过）
  // 2026-10-22 用户令：会话"想不起来用 vault"⇒ 两条机械兜底。判据都能用一条 if 判出来，
  // 所以下沉到守卫；技能只负责"该不该用"的判断。凭据来源统一指到 `dsh-vault`（免密入口已装好）。
  denyInlineCredentials: true,   // 命令里带明文凭据（Authorization/sshpass/--password=/user:pass@/敏感名赋值）⇒ 拦
  denySecretFileRead: true,       // 用 cat/grep/source 等去 .env / credentials.json / .netrc 里找密钥 ⇒ 拦
  // 2026-10-22 用户令：经验库里有大量"生成时就错"的错误，等到事故复现多次才纠正太慢。
  // 这类错误不用跑就知道错 ⇒ 在 exec 之前静态判。用户裁定「A 直接做好」⇒ 默认 deny；
  // 每次命中都落 ~/.dsh/static-check.jsonl（灰度与拦截都留底，否则事后没法收窄规则）。
  staticCheckMode: "log",         // off | log | deny（2026-10-22 用户批准灰度：默认只记台账）
  staticCheckLogUntil: "2026-10-29",  // 灰度到期日：mode=log 且 今天 > 此日 ⇒ 自动按 deny 处置
  // 2026-10-23 用户批准：bash 语法判据交给 shellcheck（0.11.0 实测：函数名 / case 通配 / 破坏性形状
  // 一律 0 条 ⇒ 自研的 command-missing / 破坏性动词判据保留，不删）。
  // 开关名：shellcheckPath / shellcheckSeverity / shellcheckExclude / shellcheckTimeoutMs。
  // 失效症状①「语法错没拦」：先看台账行有没有 rule:"shellcheck-missing"（⇒ shellcheck 没就绪，
  //   本轮语法判据失明，已显式写进拒绝文案，不是判过了）。
  // 失效症状②「warning 也拦下来了」：shellcheckSeverity 被写成 warning/info/style——默认 error
  //   是用户批准的中档（error 拦、warning 只进台账）。
  // 失效症状③「某个 SC 码不见了」：它在 shellcheckExclude 里（台账行 excluded:[SC…] 留痕）。
  shellcheckPath: "/home/loong/.local/bin/shellcheck",   // 必带 -s bash（不带时 rm -rf / 会冒出 SC2148 噪声，实测）
  shellcheckSeverity: "error",   // E 档线：error ⇒ E；warning/info/style ⇒ W（只落台账）
  shellcheckExclude: [],         // 形如 ["SC2148"]：命中的 code 从结果剔除，台账 excluded 留痕
  shellcheckTimeoutMs: 15000,    // 必带超时（spawnSync 无超时 = 可被拖死）；超时 ⇒ 显式降级，不静默。
                                 // 2026-10-23 缺口3：5000 撞过线（实测 2 万行 4.5s 是常态量级），默认抬到 15000；
                                 //   撞线文案会写明"超时 15s"与本轮新默认（见 SHELLCHECK_TIMEOUT_NOTICE）。
  // 2026-10-23 缺口1：shebang 指向非 bash 解释器的脚本，喂给 `shellcheck -s bash` 出的是噪声 E
  //   （实测真文件 #!/usr/bin/env python3 + `print(1` ⇒ SC1036/SC1088/SC1065 三条 error）。
  //   这类脚本跳过 shellcheck，改记一条 non-bash-shebang W；command-missing / path-missing 照跑。
  //   失效症状①「python 脚本被 shellcheck 拦下来」⇒ 看台账有没有 non-bash-shebang 行（有 = 已跳过，非通过）。
  //   失效症状②「bash 脚本被一起跳过了」⇒ 白名单 SHEBANG_BASH_INTERPRETERS 写漏了名字（下面那行）。
  //   失效症状③「shebang 行上有多个词」（`#!/usr/bin/env -S bash -eu`）⇒ 判据取解释器路径基名，不数旗标。
  pwshParser: "auto",            // 开关名：pwshParser。off ⇒ 显式降级（不判）；auto ⇒ 真加载 tree-sitter 出 E。
                                 //   三条失效症状（都写成台账行 + notices，绝不静默算通过）：
                                 //   ①「pwsh 语法错没拦」⇒ 台账行 rule:"pwsh-no-parser" ⇒ 本轮未参与检查；
                                 //   ②「包没装 / 加载失败（含 .node 架构不匹配、import 超时、Parser 构造抛错）」
                                 //     ⇒ reason 写明 cause 与错误摘要，同样落 pwsh-no-parser W，**不是通过**；
                                 //   ③「pwshParser 被设成 off」⇒ available:false，reason:"config off"。
  pwshLoadBudgetMs: 2000,        // import 装载预算（插件加载阶段超时用）。不是 Config 键（宿主 schema 只认声明过的键，
                                 //   实测：多一个键 ⇒ 整份插件配置校验失败），所以只作函数入参的缺省值。
  // 2026-10-22（社区：Claude Code Plan Mode 的权限降级 / Cline Plan&Act / Spec Kit 分阶段）：
  // 方案文件存在且 status: draft ⇒ 禁一切改盘动作，只允许只读侦察与写方案。
  // 批准必须是用户给的：status: approved 且记录了逐字用户消息，未记录一律当 draft。
  planFile: "~/.dsh/plans/{cwd}/active.md",   // 2026-10-22：按工作区分片（原单文件会串会话）
  // 2026-10-22：L3 版经验库触发器。同一条命令（归一化后）在窗口内出现 N 次 ⇒ 拦，
  // 并把 经验库/INDEX.md 里命中的症状行塞进拒绝消息（模型不用自己想起来去 grep）。
  gotchaIndex: "~/.dsh/gotchas/INDEX.md",
  repeatDenyAt: 3,
  repeatWindowMinutes: 30,
  repeatExempt: "bin/lint|bin/plugin-tests|git (status|diff|log|show)|^cat |^ls ",
  // 2026-10-22 FM-1.5（MAST：不知道何时该停）：同一文件连续写出相同内容 = 空转。
  stallAt: 3,
  denyWritesWhilePlanDraft: true,
  snapshotSlot: "~/.dsh/snapshots/latest",
  snapshotTargets: [
    "~/.dsh/profiles", "~/.dsh/skills", "~/.dsh/skillsets", "~/.dsh/AGENTS.md",
    "~/.config/systemd/user", "/home/loong/.local/lib/node_modules/@deepseek-ai",
    "/home/loong/dsh-self-recall", "/home/loong/dsh-vision-forward", "/home/loong/dsh-tool-guard",
  ],
  snapshotExempt: ["~/.dsh/snapshots", "~/.dsh/tool-guard.log", "/tmp", "/home/loong/文档"],
};

/** 拆段：堵「换行后藏命令」与链式操作符 */
function segments(cmd) {
  return String(cmd)
    .replace(/\\\s*&&/g, "&&")   // 去反斜杠转义的操作符（\ &&）
    .replace(/\\\s*\|\|/g, "||")
    .replace(/\\\s*\|/g, "|")
    .split(/[\n;]+|\s&&\s|\s\|\|\s|\s\|\s|&&|\|\||\|\(|\$\(/)
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * 收集同一条命令里的「字面量赋值」。只认不含 $ 与反引号的值；
 * 解不出来的一律原样保留 ⇒ 仍然走拒绝。
 * 依据：命令里先赋一个绝对路径、再在删除/查找里引用它，是日常高频形态，
 * 而变量名本身无法静态判定 ⇒ 第一版把所有变量目标一刀拒掉，误杀面很宽。
 */
function collectVars(cmd) {
  const out = {};
  const rx = /(?:^|[\s;(])([A-Za-z_][A-Za-z0-9_]*)=("([^"$`]*)"|'([^'$`]*)'|([^\s;|&()$`"']+))/g;
  for (const m of String(cmd).matchAll(rx)) {
    const val = m[3] ?? m[4] ?? m[5] ?? "";
    if (val) out[m[1]] = val;
  }
  return out;
}

/** 把 $VAR / ${VAR} 前缀换成已解出的字面量；解不出返回原样（后续判据会拒） */
function resolveVar(raw, vars) {
  const m = /^\$\{?([A-Za-z_][A-Za-z0-9_]*)\}?(.*)$/.exec(raw);
  if (!m) return raw;
  const v = vars[m[1]];
  return v ? v + m[2] : raw;
}

function tokens(seg) {
  return seg.split(/\s+/).filter(Boolean);
}

/** argv[0] 的可执行名（去绝对路径），用于窄面匹配。跳过前缀包装器：`sudo rm -rf` 必须等于 `rm -rf` */
const WRAPPERS = new Set(["sudo", "doas", "env", "time", "nice", "nohup", "setsid", "stdbuf", "command", "exec", "disown"]);
function argv0(seg) {
  return parseArgv(seg).exe;
}

/** 返回 { exe, rest }：rest 是 argv[1:]，包装器与 VAR= 前缀已跳过 */
function parseArgv(seg) {
  const t = tokens(seg);
  let i = 0;
  while (i < t.length) {
    const tok = t[i];
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(tok)) { i += 1; continue; }
    if (WRAPPERS.has(basename(tok))) { i += 1; continue; }
    break;
  }
  return { exe: basename(t[i] || ""), rest: t.slice(i + 1) };
}

function flagsOf(seg) {
  return tokens(seg).filter((t) => t.startsWith("-"));
}


/** 系统目录：整根递归强删一律拒（不是"逐命令批准"，是没有商量的余地） */
const TIER0_ROOTS = new Set([
  "/", "/home", "/usr", "/etc", "/var", "/boot", "/opt", "/srv", "/root",
  "/bin", "/sbin", "/lib", "/lib64", "/proc", "/sys", "/dev", "/run",
]);

/**
 * 递归强删的单个目标判据。返回拒绝理由，或 undefined 表示放行。
 * 分三档：根部/变量/通配 ⇒ 拒；可抛弃区内的具名子项 ⇒ 放；其余 ⇒ 拒并给隔离区路标。
 */
function rmTargetVerdict(target, disposeAllow, vars = {}) {
  const raw = resolveVar(String(target).replace(/^['"]|['"]$/g, ""), vars);
  if (!raw) return "`rm -rf` 目标为空，拒绝。";
  if (/[$`]/.test(raw)) {
    return "Never 级：`rm -rf $VAR` 变量未校验即禁。先 `echo \"$VAR\"` 核对展开后的绝对路径，确认是本次产生的路径，再逐个点名删除（R-03 / R-12）。";
  }
  if (["/", "/*", ".", "..", "./*", "*", "~", "~/"].includes(raw)) {
    return "Never 级：对根目录 / 当前目录 / 通配符 / 家目录无界递归强删即禁。改成只删本次产生的具名路径（R-03）。";
  }
  const abs = raw.startsWith("~") ? expand(raw) : raw;
  if (abs.startsWith("/")) {
    if (TIER0_ROOTS.has(abs) || /^\/home\/[^/]+$/.test(abs)) {
      return "Never 级：对系统目录或整个家目录做递归强删即禁（R-03）。";
    }
    const inDispose = disposeAllow.some((r) => abs !== r && under(abs, [r]));
    if (inDispose) return undefined;
    const zones = disposeAllow.length ? disposeAllow.join(" ") : "（未配置 disposeAllow）";
    return `破坏性动词需逐命令批准：\`rm -rf\` 打在 \`${raw}\` 上。免批区（可抛弃区）：${zones}。两个合规走法：① 移到隔离区（\`mv\` 到带时间戳的 trash 目录，可恢复优先于消失）；② 先报出确切路径与影响面，得到点头再跑（R-03 / R-12）。`;
  }
  // 相对路径：以 .. 开头或含通配 ⇒ 可能逃出当前目录，拒；否则视作当前目录下的具名项
  if (raw.startsWith("..") || raw.includes("*")) {
    return `相对路径 \`${raw}\` 可能逃出当前目录，拒绝。改成明确路径，或移进隔离区（R-03）。`;
  }
  return undefined;
}

/** R-03：破坏性动词。返回路标理由，或 undefined */
function destructive(seg, disposeAllow = [], vars = {}) {
  const exe = argv0(seg);
  const tk = tokens(seg);
  const fl = flagsOf(seg);
  const has = (re) => tk.some((t) => re.test(t));

  if (exe === "rm") {
    const recursive = fl.some((f) => /^--recursive$/.test(f) || (/^-[^-]/.test(f) && f.includes("r")));
    const force = fl.some((f) => /^--force$/.test(f) || (/^-[^-]/.test(f) && f.includes("f")));
    if (recursive && force) {
      const targets = parseArgv(seg).rest.filter((t) => !t.startsWith("-"));
      if (!targets.length) return "`rm -rf` 未给目标：拒绝（R-03）。";
      for (const target of targets) {
        const verdict = rmTargetVerdict(target, disposeAllow, vars);
        if (verdict) return verdict;
      }
      return undefined; // 全部落在可抛弃区 / 当前目录具名项 ⇒ 放行
    }
  }

  if (exe === "find" && (tk.includes("-delete") || (tk.includes("-exec") && tk.some((t) => /^(rm|unlink)$/.test(t))))) {
    const root = (parseArgv(seg).rest.find((t) => !t.startsWith("-")) || "").replace(/^['"]|['"]$/g, "");
    const absRoot = expand(resolveVar(root, vars));
    if (absRoot.startsWith("/") && disposeAllow.some((r) => absRoot !== r && under(absRoot, [r]))) return undefined;
    return "破坏性动词需逐命令批准：`find … -delete` / `-exec rm` 等同递归强删。把搜索根限定在可抛弃区可直接放行；否则先列出将被删的清单交用户核对（R-03 / R-12）。";
  }

  if (exe === "git") {
    const sub = parseArgv(seg).rest[0] || "";
    if (sub === "reset" && tk.includes("--hard")) {
      return "`git reset --hard` 丢弃未提交改动，属逐命令批准项。先 `git status --short` 看清既有改动并 commit / 备份，再向用户报备（R-12）。";
    }
    if (sub === "clean" && fl.some((f) => f.includes("f"))) {
      return "`git clean -f` 删除未跟踪文件，属逐命令批准项。先 `git clean -nd` 干跑列出清单交用户核对（R-03）。";
    }
    if (sub === "stash" && ["drop", "clear", "pop"].includes(parseArgv(seg).rest[1])) {
      return "`git stash " + parseArgv(seg).rest[1] + "` 丢弃暂存内容，属逐命令批准项。先 `git stash list` 与 `git stash show` 核对（R-03）。";
    }
    if (sub === "push" && (tk.includes("--force") || tk.includes("-f"))) {
      return "不要用 `git push --force`。改用 `git push --force-with-lease`（远端被他人更新时安全失败）。";
    }
  }

  if (["dnf", "yum"].includes(exe) && (tk.includes("remove") || tk.includes("-e"))) {
    return "系统包移除属逐命令批准项（内核误删事故即属此类）。先报出包名与依赖影响面，得到用户点头（R-03）。";
  }
  if (exe === "rpm" && tk.includes("-e")) {
    return "`rpm -e` 移除包属逐命令批准项。先报出包名与依赖影响面，得到用户点头（R-03）。";
  }
  if (exe === "dd" && tk.some((t) => /^if=/.test(t))) {
    return "`dd` 直写设备/文件属逐命令批准项。先报出 if=/of= 的绝对路径与字节数（R-03）。";
  }
  if (/^(mkfs(\.\w+)?|fdisk|parted)$/.test(exe)) {
    return "磁盘格式化/分区操作属逐命令批准项，且属 Never 级风险。停下交真人前台确认（R-03）。";
  }
  if (exe === "killall" && tk.includes("-9")) {
    return "`killall -9` 按名字广播强杀，会连带杀掉无关进程与你自己的载体。改用精确 PID：先 `ps -o pid,ppid,cmd -p <PID>` 核对（R-07）。";
  }
  if (["npm", "yarn", "pnpm", "bun"].includes(exe) && tk.includes("--force")) {
    return "`audit fix --force` 会跨大版本改依赖，属逐命令批准项。先报出将变更的包与版本跨度（R-03）。";
  }
  return undefined;
}

/** R-03：绕过 wrapper / 自动喂确认 */
function bypass(seg) {
  const exe = argv0(seg);
  if (/^\/(bin|usr\/bin|usr\/sbin)\/(rm|git|kill|killall)$/.test(exe)) {
    return "用绝对路径绕过 wrapper 属「绕过防线」，禁止。改用被包装的命令；认为必须绕过 → 先问用户并说明为什么（R-03）。";
  }
  if (/\.real$/.test(exe)) {
    return "调用 `*.real` 备份二进制属「绕过防线」，禁止（R-03）。";
  }
  // 只保留「喂进 rm/git」的无空格形态（带空格的由拆段接走）；
  // 喂进提权器的形态已改由 interactivePipe 按管道右侧判定（见其注释）
  if (/\becho\b[^\n]*\|\s*(rm|git)\b/.test(seg)) {
    return "把确认答案用 `echo … |` 喂进 rm/git = 「自己确认」，禁止。停下交真人前台确认（R-03）。";
  }
  const tk = tokens(seg);
  if (tk.some((t) => /^(SAFEEXEC|GUARD|SANDBOX|HOOK|APPROVAL)[A-Z_]*=/.test(t))) {
    return "设置「关掉检查」的环境变量属「绕过防线」，禁止。认为必须绕过 → 先问用户并说明为什么（R-03）。";
  }
  return undefined;
}

/** R-07：pkill -f 自匹配；pgrep -f 的永不退出循环 */
function selfMatch(seg) {
  const exe = argv0(seg);
  const tk = tokens(seg);
  if (exe === "pkill" && (tk.includes("-f") || tk.includes("--full"))) {
    return "`pkill -f` 匹配所有进程的完整命令行，包括运行这条命令的 shell 自己 → 会杀掉你自己的载体。三步替代（照抄）：① `pidof <可执行名>` 看在不在  ② `ps -o pid,ppid,cmd -p <PID>` 核对是不是目标  ③ `kill <PID>`。确需按命令行过滤时用带 comm 白名单的形态（不要用 pkill）：`pgrep -f <模式> | while read p; do [ \"$(ps -o comm= -p $p)\" = <名字> ] && kill \"$p\"; done`（R-07）。";
  }
  if (/\bpgrep\s+-[a-z]*f\b/.test(seg) && /\buntil\b/.test(seg)) {
    return "`until ! pgrep -f …; do …; done` 永不退出：pgrep 匹配到调用它的 shell 自己。改用 `pidof` 或 PID 文件（R-07）。";
  }
  return undefined;
}

/** 管道右侧 = 「交互式提权消费」⇒ 把确认答案/密码喂给自己（R-03）。
 *  只认提权器读 stdin 的形态：sudo -S / --stdin / 合并短选项里的 -S、pkexec、doas、su、confirm*。
 *  数据管道不算：`echo "内容" | sudo tee /etc/x`（写配置文件的标准写法）、
 *  `… | sudo -u nobody …`、`… | ssh …`、heredoc 体内 `grep … | sudo tee`。
 *  2026-10-19 实测收窄：旧判据 `echo … | sudo` 位置无关（跨换行/跨引号/跨 heredoc），
 *  日志 8 条 R-03 拒绝里 6 条是这种误杀，真命中只有 2 条（`echo <password> | sudo -S`）。
 *  注意：这里不能用 parseArgv —— 它会把 `sudo` 当包装器跳掉（那是破坏性判据要的语义）。 */
function interactivePipe(cmd) {
  const rights = String(cmd).split(/\s*(?:\|\&|2>\&1\s*\||\|)\s*/).slice(1);
  for (const right of rights) {
    const t = tokens(right);
    const exe = basename(t[0] || "");
    if (!exe) continue;
    const stdinSudo = exe === "sudo" && t.slice(1).some((x) => x === "--stdin" || /^-[A-Za-z]*S[A-Za-z]*$/.test(x));
    if (stdinSudo || exe === "pkexec" || exe === "doas" || exe === "su" || /^confirm/.test(exe)) {
      return `管道右侧是交互式提权消费（\`${exe}${stdinSudo ? " -S" : ""}\` 读 stdin）= 把确认答案/密码喂给自己，禁止。停下交真人前台确认（R-03）。数据管道（\`| sudo tee\` 等）不属本判据。`;
    }
  }
  return undefined;
}

/** 整条命令级判据（跨管道、跨换行的形态，拆段后看不到） */
function wholeCommand(cmd) {
  if (/: *\(\) *[:{]/.test(cmd) && cmd.includes(":|:&")) {
    return "fork bomb，禁止执行。";
  }
  // 把确认答案/密码喂进交互式提权提示（跨管道）
  const pipe = interactivePipe(cmd);
  if (pipe) return pipe;
  // 用「命令行模式」挑进程直接杀：判据是那类动作，不是某个写法。
  // 2026-10-22 实测：旧规则只挡 pkill -f、管道给 xargs kill、以及 until 循环三种写法，
  // 而命令替换 kill $(pgrep -f …)、while read 循环、ps|grep|awk|xargs kill 全部放行
  // ⇒ 用户执行带该模式的命令时，把本次调用链一起 SIGTERM 了。
  // 危险与写法无关：管道、xargs、命令替换、while 循环都会把调用者的 shell 自己算进匹配集。
  const patPick = /\bpgrep\s+(-[a-z]*f|--full)\b|\bpkill\s+(-[a-z]*f|--full)\b|\bps\b[^|\n]*\|\s*(?:grep|egrep)\b/;
  const kills = /\b(kill|killall)\b|\bxargs\b[^\n]*\bkill\b/;
  const whitelist = /comm=|\bpidof\b|--pid\b|\bppid\b/;
  if (patPick.test(cmd) && kills.test(cmd) && !whitelist.test(cmd)) {
    const pat = patternOf(cmd);
    const who = whoWouldDie(pat, { selfPids: selfPidSet(), jobPgids: jobPgidMap() });
    const whoText = who.length
      ? `\n这条命令会命中这些进程：\n  - ${who.join("\n  - ")}\n`
      : "\n（当前没有进程的 cmdline 含该模式；但你自己的 shell 会在执行时因为命令行含它而被算进去）\n";
    const base = whoText + "要清掉某个重活窗口请用 `proc_kill({jobId})`（按进程组，构造上杀不到调用者）；要看清全部进程调 `proc_list`。\n";
    return base + "用命令行模式挑进程直接杀，会把运行这条命令的 shell 自己算进匹配集（本次调用链一起死）。**拆成两条命令**：① `pgrep -f <模式>` 只看清单；② `ps -o pid,ppid,cmd -p <PID>` 核对到具体 PID 后 `kill <PID>`。确需批量过滤时必须带白名单：`pgrep -f … | while read p; do [ \"$(ps -o comm= -p $p)\" = <可执行名> ] && kill \"$p\"; done` 或 `pidof <可执行名>`（R-07 / L2 process-shell-safety）。";
  }
  return undefined;
}

/** R-12：重启宿主与后台拉起同条命令 */
function restartWithBackground(cmd, services) {
  const restart = new RegExp(`systemctl[^\\n]*\\brestart\\b[^\\n]*(${services.join("|")})`);
  if (!restart.test(cmd)) return undefined;
  // 后台操作符必须是独立的 `&`：`&&` 是链式操作符，不是后台
  // （2026-10-15 实测：`[ … ] && { … }` 里的 `&&` 被当成后台 ⇒ 合法重启被误杀）
  const backgrounded = /\bsetsid\b|\bnohup\b|\bdisown\b/.test(cmd) || /(?:^|[\s;])&(?!&)/.test(cmd);
  if (!backgrounded) return undefined;
  return "宿主重启会切断当前会话载体，连带杀掉同一调用内启动的脚本与后台 job（`setsid nohup disown` 同样被回收），闸门会跑到中途无人收尾。拆成三个独立调用：① 执行动作且本调用内不重启，当场核对产物；② 单独调用只重启；③ 单独调用跑测量与判据。需要跨重启存活就交给 systemd unit（R-12）。";
}

function expand(p) {
  return String(p).replace(/^~/, homedir());
}

/* ── 快照闸门（规则 R-12「改动可回退」的机制层兜底）────────────────
 * 判据：写入「被运行中的宿主消费的产物」⇒ 单槽快照位里必须有该目标的快照 ⇒ 无则拒绝。
 * 按消费者分类，不按文件位置分类（R-12 第一条）。
 * 已知保证不了的：快照新鲜度（闸门看不出快照是不是本次动手前做的）⇒ 靠纪律。
 */

/** snap.sh 的镜像命名：去掉前导 /，其余 / 换成 __ */
function mirrorName(p) {
  return p.replace(/^\//, "").replace(/\//g, "__");
}

/** 目标自身有快照，或某个祖先目录有 tar.gz 快照 */
function snapshotExists(slot, p) {
  const self = join(slot, mirrorName(p));
  if (existsSync(self) || existsSync(`${self}.tar.gz`)) return true;
  let cur = p;
  for (let i = 0; i < 12; i += 1) {
    const next = dirname(cur);
    if (next === cur) break;
    if (existsSync(`${join(slot, mirrorName(next))}.tar.gz`)) return true;
    cur = next;
  }
  return false;
}


/** 闸门放行前的自动快照：只对已存在的小文件同步拍一张，失败就退回拒绝。 */
function tryAutoSnapshot(slot, p, maxBytes) {
  try {
    const st = statSync(p);
    if (!st.isFile() || st.size > maxBytes) return false;
    const dest = join(slot, mirrorName(p));
    mkdirSync(dirname(dest), { recursive: true });
    copyFileSync(p, dest);
    return true;
  } catch {
    return false;
  }
}

function under(p, prefixes) {
  return prefixes.some((pre) => p === pre || p.startsWith(`${pre}/`));
}

/**
 * 从 shell 命令里取「内容会被改写的绝对路径」。
 *
 * 第一版只做一件事：把写入类动词后面所有以 / 或 ~ 开头的 token 全算成写入点。
 * 代价是两类系统性误杀（2026-10-21 日志回放）：
 *   - 方向不分：`cp <插件文件> /tmp/备份` 把**源**也当成写入点；
 *   - 动词不分：`chmod` / `mkdir` / `touch` 根本不改内容，拍了快照和没拍一样。
 *
 * 现在按动词分类：
 *   metadata 类 ⇒ 不计（快照对它们没有意义）
 *   方向敏感类 ⇒ 只取目的地
 *   其余内容类 ⇒ 取全部目标
 */
/** 会被快照闸门关心的动词全集（metadata 类在内，但会被上面的判据先排除） */
const WRITE_VERBS = new Set([
  "rm", "mv", "cp", "install", "tee", "dd", "truncate", "rsync", "patch",
  "chmod", "chown", "chgrp", "ln", "touch", "mkdir", "rmdir", "tar", "unzip", "sed",
]);
const METADATA_VERBS = new Set(["chmod", "chown", "chgrp", "touch", "mkdir", "rmdir", "ln"]);
const DEST_ONLY_VERBS = new Set(["cp", "install", "rsync"]);
const CONTENT_VERBS = new Set(["rm", "mv", "tee", "dd", "truncate", "patch", "unzip", "sed", "tar"]);

function isPathish(tk) {
  return tk.startsWith("/") || tk.startsWith("~");
}
function clean(tk) {
  return expand(tk.replace(/^['"]|['"]$/g, ""));
}
/** 取某个选项后面紧跟的值（-C dir / -d dir / -t dir / --directory=dir） */
function optValue(rest, names) {
  for (let i = 0; i < rest.length; i += 1) {
    const tk = rest[i];
    for (const n of names) {
      if (tk === n && rest[i + 1]) return rest[i + 1];
      if (tk.startsWith(`${n}=`)) return tk.slice(n.length + 1);
      if (n.length === 2 && tk.startsWith(n) && tk.length > 2) return tk.slice(n.length); // -Cdir
    }
  }
  return undefined;
}

export function shellWriteTargets(cmd) {
  const out = [];
  // 重定向目标永远算
  for (const m of String(cmd).matchAll(/(?:^|[\s;])>>?\s*(['"]?)(\/[^\s'"]+)\1/g)) out.push(m[2]);

  for (const seg of segments(cmd)) {
    const argv = parseArgv(seg);
    const exe = basename(argv.exe);
    if (!exe || METADATA_VERBS.has(exe) || !WRITE_VERBS.has(exe)) continue;

    const rest = argv.rest;
    const operands = rest.filter((t) => !t.startsWith("-"));

    if (exe === "sed") {
      if (!rest.includes("-i")) continue;
      for (const tk of operands.slice(1)) if (isPathish(tk)) out.push(clean(tk));
      continue;
    }
    if (exe === "tar") {
      const dir = optValue(rest, ["-C", "--directory"]);
      if (dir) out.push(clean(dir));
      continue;
    }
    if (exe === "unzip") {
      const dir = optValue(rest, ["-d"]);
      if (dir) out.push(clean(dir));
      continue;
    }
    if (exe === "dd") {
      for (const tk of rest) if (/^of=/.test(tk)) out.push(clean(tk.slice(3)));
      continue;
    }
    if (DEST_ONLY_VERBS.has(exe)) {
      const td = optValue(rest, ["-t", "--target-directory"]);
      const dest = td || operands[operands.length - 1];
      if (dest && isPathish(dest)) out.push(clean(dest));
      continue;
    }
    // 内容类其余：rm / mv / tee / truncate / patch —— 全部目标都算（mv 的源也是被移走的）
    for (const tk of operands) if (isPathish(tk)) out.push(clean(tk));
  }
  return out;
}


// ── 本轮用户消息捕获（agent/pre-step 的载荷带 messages）──────────────────

/** 从命令里取出 -f 后面那个模式（只用于向用户展示会命中谁）。 */
export function patternOf(cmd) {
  const m = String(cmd || "").match(/\b(?:p|pg)kill?\w*\b[^\n]*?\s-[a-zA-Z]*f\s+["']?([^"'\s|;)]+)/)
    || String(cmd || "").match(/\bpgrep\b[^\n]*?\s-[a-zA-Z]*f\s+["']?([^"'\s|;)]+)/);
  return m ? m[1] : "";
}

/** 列出「按这个模式会被杀掉」的进程，并标注归属：self=调用链 / protected=宿主与引擎 / job=重活窗口 / foreign。 */
export function whoWouldDie(pattern, { selfPids = new Set(), jobPgids = new Map() } = {}) {
  if (!pattern) return [];
  const r = spawnSync("ps", ["-eo", "pid=,pgid=,args="], { encoding: "utf8", timeout: 5000 });
  const rows = [];
  for (const line of String((r && r.stdout) || "").split("\n")) {
    const t = line.trim();
    if (!t) continue;
    const m = t.match(/^(\d+)\s+(\d+)\s+(.*)$/);
    if (!m) continue;
    const pid = Number(m[1]), pgid = Number(m[2]), cmdline = m[3];
    if (!cmdline.includes(pattern)) continue;
    let owner = "foreign";
    if (selfPids.has(pid)) owner = "self(你自己的调用链)";
    else if (/dsh-web|llama-swap|llama\.cpp|serve\/server\.py|engine\/strata/.test(cmdline)) owner = "protected(宿主/引擎)";
    else if (jobPgids.has(pgid)) owner = `job:${jobPgids.get(pgid)}`;
    rows.push(`${pid}(pgid ${pgid}) ${owner} ${cmdline.slice(0, 60)}`);
    if (rows.length >= 8) break;
  }
  return rows;
}

function selfPidSet() {
  const out = new Set();
  let pid = process.pid;
  for (let i = 0; i < 12 && pid > 1; i += 1) {
    out.add(pid);
    try {
      const st = readFileSync(`/proc/${pid}/stat`, "utf8");
      pid = Number(st.slice(st.lastIndexOf(")") + 2).split(" ")[1]);
    } catch { break; }
  }
  return out;
}

function jobPgidMap() {
  const map = new Map();
  const dir = `${process.env.HOME || "/home/loong"}/.dsh/arbitrate/jobs`;
  try {
    for (const f of readdirSync(dir)) {
      if (!f.endsWith(".json")) continue;
      try {
        const j = JSON.parse(readFileSync(`${dir}/${f}`, "utf8"));
        if (j && j.pgid) map.set(Number(j.pgid), String(j.jobId || j.label || f));
      } catch { /* 跳过坏文件 */ }
    }
  } catch { /* 目录不存在 */ }
  return map;
}

export function messageText(m) {
  if (!m) return "";
  const c = m.content;
  if (typeof c === "string") return c;
  if (Array.isArray(c)) return c.map((x) => (typeof x === "string" ? x : x?.text ?? "")).join(" ");
  return "";
}

export function latestUserText(messages) {
  if (!Array.isArray(messages)) return "";
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    if ((messages[i]?.role || "") === "user") return messageText(messages[i]).slice(0, 2000);
  }
  return "";
}

// 会中断生产的动作
/** 本轮用户消息**按会话隔离**（2026-10-22：模块级单槽会让 A 会话的授权串到 B 会话）。 */
const sessionTexts = new WeakMap();   // agent → { text, at }
let fallbackUserText = "";            // 取不到 agent 时的退路（测试/极少数路径）

function userTextOf(agent) {
  // 有 agent 就只认它自己的记录：查不到 = 没授权（绝不回落到别的会话的退路值）
  if (agent) { const hit = sessionTexts.get(agent); return hit ? hit.text : ""; }
  return fallbackUserText;
}

/** 记录某会话的本轮用户消息（pre-step 与测试共用；按 agent 隔离）。 */
export function noteUserText(agent, text) {
  const t = String(text || "");
  if (!t) return;
  if (agent) sessionTexts.set(agent, { text: t, at: Date.now() });
  // 2026-10-22 修串台：原来这里无条件写 fallbackUserText ⇒ 真实会话的原话会漏进「没有 agent」
  // 的调用，等于隔壁会话的原话可以给本会话授权重启。现在 fallback 只由 setSessionUserText
  // （测试注入用）设置，拿不到 agent 的一律按「没授权」处理（fail-closed）。
}

/** 测试与插件内部用：设置「本轮用户消息」的默认值。模型无法调用 JS 函数，故不构成绕过。 */
export function setSessionUserText(t) { fallbackUserText = String(t || ""); }
export function getSessionUserText(agent) { return userTextOf(agent); }

const RESTART_RES = [
  /\bsystemctl\b[^\n]*\b(restart|stop|kill)\b/,
  /\bservice\b[^\n]*\b(restart|stop)\b/,
  /\bsystemd-run\b[^\n]*\brestart\b/,
  /\b(kill|pkill|killall)\b[^\n]*(dsh-web|llama-swap|llama\.cpp|server\.py|engine)/,
];
const AUTH_RES = [/重启/, /\brestart\b/i, /停(掉|止)?服务/, /掐断/, /授权/, /可以(杀|停|重启)/, /都批准/];
const NEG_RES = [/(不要|别|不用|先别|暂不|禁止|不许)[^\n]{0,8}(重启|restart|停|杀)/i];

/** 本轮用户消息是否明确授权重启/中断生产。否定句优先（"不要重启" 不算授权）。 */
export function isRestartAuthorized(userText) {
  const t = String(userText || "");
  if (!t.trim()) return false;
  if (NEG_RES.some((re) => re.test(t))) return false;
  return AUTH_RES.some((re) => re.test(t));
}

/** 重启类授权闸：返回拒绝理由或 undefined。纯函数，可单测。 */

const HOLD_CUE = /(先别|还没定|我先看|我看看|正在(分析|看|读|想)|不急|等我说|别急|想想再说|待定)/;
const PUSHBACK = /(走哪条|选哪条|哪一条|哪个方案|选一个|挑一条|要我选|你来定)/;
const PLAN_LEVEL = /(迁出|迁移|删除|清理|处置|归档|移走|范围|批量|授权|清单|隔离区)/;
const ONE_WAY = /\[one-way\]|【单行道】|不可逆/;
const TWO_WAY = /\[two-way\]|【双行道】|可逆决策/;
const HAS_DEFAULT = /默认[:：]|不回复就|不问就/;

const ASK_TEMPLATE = [
  "提问必须标注可逆性，并自带默认值（社区判据：Bezos 单/双行道 + 12-factor #7 结构化求助）：",
  "· header 写 [one-way] 或 [two-way]",
  "· 问题里写 `默认：<不问就按这个走>` 与后果",
  "[two-way]（可逆）⇒ 不要问，直接按你判断做，并在回复里说明选了哪条；只有 [one-way]（不可逆）才允许问。",
].join("\n");

/**
 * 该不该允许这次提问（纯函数）。
 * 主判据是**可逆性 + 是否带默认值**，不是猜用户心情；
 * 用户明确在按住（HOLD）或明显在把决定权推回去（PUSHBACK）时作为第二道拦截。
 */
export function askGate({ userText = "", question = "", options = "", enabled = true } = {}) {
  if (!enabled) return undefined;
  const u = String(userText || "");
  const q = `${question || ""} ${options || ""}`;

  // 第二道：用户明说在分析/别动 ⇒ 连 one-way 也不当场问
  if (HOLD_CUE.test(u)) {
    return `用户还在分析（本轮消息：「${u.slice(0, 80)}」）。**现在什么也别问**：给材料、写取舍、按默认路径推进（可逆就先做）。等他明确要你定或要你动手。`;
  }

  // 方案层决定：不看可逆性，一律不许自决、也不许此刻问
  if (PLAN_LEVEL.test(q)) {
    return "这是**方案层**决定（做什么/改什么/删什么/范围多大），不是执行细节：**不许自决，也不许现在问**。\n"
      + "把取舍、代价、回退、不做什么写成方案，**等用户看完表态**；他批准后，方案内部的执行细节（先做哪个、用哪条命令）才轮到你自己定。";
  }

  const oneWay = ONE_WAY.test(q);
  const twoWay = TWO_WAY.test(q);
  const hasDefault = HAS_DEFAULT.test(q);

  if (twoWay && !oneWay) {
    return `这是可逆决策（[two-way]）⇒ **不要问**：直接按你的判断做，在回复里用一行说明你选了哪条、怎么退回。${PUSHBACK.test(q) ? "\n（问「走哪条」正是在把决定权推回去。）" : ""}`;
  }
  if (oneWay && !hasDefault) {
    return "不可逆动作可以问，但**必须自带默认值**：「默认：<不问就按这个走>」+ 失败后果 + 回退方式。没有默认值就是把人卡在白屏上。";
  }
  if (!oneWay && !twoWay) {
    return ASK_TEMPLATE + (PUSHBACK.test(q) ? "\n（且你这次问的是「走哪条」，本身就是把决定权推回去。）" : "");
  }
  return undefined; // [one-way] + 默认值 ⇒ 放行
}


/** 解析计划文件状态。返回 { exists, status, approved, scope }。 */

/** 命令归一化指纹：数字→N、折叠空白、去引号差异。同一"形状"得同一指纹。 */

/** 内容短哈希（djb2）：用于判断"写了等于没写"。 */
export function contentHash(text) {
  let h = 5381;
  const s = String(text || "");
  for (let i = 0; i < s.length; i += 1) h = ((h * 33) ^ s.charCodeAt(i)) >>> 0;
  return h.toString(16);
}

/**
 * 停滞闸（FM-1.5）：同一目标连续 at 次写入内容不变 ⇒ 空转，拦。
 * history: [{ target, hash }]（旧→新），返回拦截消息或 undefined。纯函数。
 */
export function stallGate({ target = "", content = "", history = [], at = 3, enabled = true } = {}) {
  if (!enabled || !target) return undefined;
  const h = contentHash(content);
  const same = (history || []).filter((e) => e && e.target === target).slice(-(at - 1));
  const allSame = same.length === at - 1 && same.every((e) => e.hash === h);
  if (!allSame) return undefined;
  return `停滞：${target} 最近 ${at} 次写入内容完全相同（哈希 ${h}）——写了等于没写。` +
    `按 FM-1.5「不知道何时该停」先停手：说明这次改动的**判据**是什么、要看到哪个输出才算进展；` +
    `如果本来就不需要改，别动文件。`;
}

export function commandFingerprint(cmd) {
  return String(cmd || "")
    .replace(/"[^"]*"/g, '"S"').replace(/'[^']*'/g, "'S'")
    .replace(/\b\d+\b/g, "N")
    .replace(/\s+/g, " ")
    .trim();
}

/** 解析 经验库/INDEX.md 的表格行。返回 [{ symptom, criterion, fix, file }] */
export function parseGotchaIndex(text) {
  const rows = [];
  for (const line of String(text || "").split("\n")) {
    if (!line.startsWith("|")) continue;
    const cells = line.split("|").map((c) => c.trim());
    if (cells.length < 6) continue;
    const [, symptom, criterion, fix, , fileCell] = cells;
    if (!symptom || symptom.includes("症状关键词") || /^-+$/.test(symptom)) continue;
    const m = String(fileCell || "").match(/\(([^)]+)\)/);
    rows.push({ symptom, criterion, fix, file: m ? m[1] : "" });
  }
  return rows;
}

/** 按"症状词 vs 命令文本"的共现打分，返回前 max 条。纯函数。 */
export function matchGotchaRows(cmd, rows, max = 2) {
  const text = String(cmd || "").toLowerCase();
  const scored = [];
  for (const r of rows || []) {
    const words = String(r.symptom || "").toLowerCase().split(/[\s,，、/|]+/).filter((w) => w.length >= 2);
    const hits = words.filter((w) => text.includes(w));
    if (hits.length) scored.push({ row: r, score: hits.length, hits });
  }
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, max).map((x) => x.row);
}

/** 重复命令闸。纯函数：给定指纹出现次数，决定是否拦、拦时附什么。 */
export function repeatGate({ cmd = "", count = 0, at = 3, rows = [], enabled = true } = {}) {
  if (!enabled) return undefined;
  if (!Number.isFinite(at) || at <= 0) return undefined;
  if (count < at) return undefined;
  const hits = matchGotchaRows(cmd, rows, 2);
  const head = `同一条命令已第 ${count} 次出现（窗口内），按 R-14「同一现象第 3 次改判」先停手：不要用同一个写法再试一次。`;
  if (hits.length) {
    const body = hits.map((h) => `· 命中经验库：**${h.symptom}**\n  判据：${h.criterion}\n  正解：${h.fix}${h.file ? `\n  详情：${h.file}` : ""}`).join("\n");
    return `${head}\n\n${body}\n\n要么按上面的正解换维度，要么先说明为什么还需要原样再跑一次。`;
  }
  return `${head}\n\n经验库索引里没找到对得上这一条的症状行——用 \`grep -i <症状词> ${"{INDEX}"}\` 自查一次，或先把这次的症状补成一条（R-06）。`;
}

export function planState(path) {
  try {
    const text = readFileSync(path, "utf8");
    const m = text.match(/^---\n([\s\S]*?)\n---/);
    const fm = m ? m[1] : "";
    const status = (fm.match(/^status:\s*(\w+)/m) || [, "draft"])[1];
    const approvedAt = (fm.match(/^approved_at:\s*(\S+)/m) || [, ""])[1];
    const approvedMsg = (fm.match(/^approved_msg:\s*(.+)$/m) || [, ""])[1].trim();
    const scope = (fm.match(/^scope:\s*(.+)$/m) || [, ""])[1].trim();
    const session = (fm.match(/^session:\s*(\S+)/m) || [, ""])[1].trim();
    // 自批不算批：approved 但没有记录用户逐字消息 ⇒ 视为 draft
    const approved = status === "approved" && Boolean(approvedAt) && Boolean(approvedMsg);
    return { exists: true, status: approved ? "approved" : "draft", approved, scope, session, raw: status };
  } catch { return { exists: false, status: "none", approved: false, scope: "" }; }
}

const STATE_CHANGING = /\b(rm|rmdir|mv|cp|sed\s+-i|truncate|dd|install|git\s+(commit|push|reset|checkout|revert)|systemctl|tee)\b/;

/**
 * 计划文件的辨认规则：任何 `plans/active.md` 或 `.dsh-plan.md` 都算。
 * 会话把它写在**任务自己所在的目录**里（R-09 领域归位），守卫据此登记本会话的计划路径，
 * 不再依赖模型猜 slug —— 旧做法实测写到了守卫读不到的目录，计划门静默失效。
 */
const PLAN_FILE_RE = /(^|\/)plans\/active\.md$|(^|\/)\.dsh-plan\.md$/;

/**
 * 工作区 → 目录名片段（只是**兜底**路径用；正式做法是会话把计划写在任务目录里，
 * 守卫由 PLAN_FILE_RE 认出并记住那份）。
 */
export function cwdSlug(cwd) {
  const s = String(cwd || "").trim();
  if (!s) return "_unknown";
  return s.replace(/\/+$/, "").replace(/\//g, "-") || "_root";
}

/** 计划未定稿时该不该拦这次动作。纯函数。 */
export function planGate({ name = "", cmd = "", plan = { exists: false }, session = "", scope = "", enabled = true } = {}) {
  if (!enabled) return undefined;
  if (!plan.exists || plan.approved) return undefined;
  // 2026-10-22 修：计划文件是全局单文件，之前会拿**别的会话**的 draft 拦住本会话（实测被拦一次，
  // 且造成"修这个缺陷的写操作也被同一缺陷拦住"的鸡生蛋死锁）。
  // 规则：计划声明了 session 且不是本会话 ⇒ 不归我管；没声明 session ⇒ 视为历史文件，不拦。
  // 2026-10-22 追加：按工作区分片后，跨工作区的同号会话也可能撞名 ⇒ 再比一次 scope。
  if (plan.session && plan.session !== session) return undefined;
  if (!plan.session) {
    if (!plan.scope || plan.scope !== scope) return undefined;   // 无 session 的老文件：只有 scope 对得上才管
  }
  const isWriteTool = name === "write" || name === "edit";
  const isShellWrite = name === "bash" && STATE_CHANGING.test(String(cmd || ""));
  const isRun = name === "arbitrate_run";
  if (!isWriteTool && !isShellWrite && !isRun) return undefined;
  return "方案还没定稿（本工作区的计划文件 `~/.dsh/plans/<cwd>/active.md` 里 status: draft）⇒ **禁止改盘**，只做只读侦察与写方案。"
    + "把取舍、代价、回退、不做什么写完，等用户看完说批准；拿到批准后把 status 改成 approved 并写上 approved_msg（用户逐字原话），才允许执行。"
    + "（社区做法：Claude Code Plan Mode 在计划期关闭全部写操作；Cline Plan/Act 分模式；Spec Kit 把 implement 拆成单独一步。）";
}

export function restartGate({ cmd = "", userText = "", enabled = true } = {}) {
  if (!enabled) return undefined;
  if (!RESTART_RES.some((re) => re.test(cmd))) return undefined;
  if (isRestartAuthorized(userText)) return undefined;
  const echo = userText ? `最新一条用户消息（逐字）：${JSON.stringify(userText.slice(0, 300))}` : "最新一条用户消息：本回合取不到（pre-step 未捕获）";
  return `【需要用户授权】这条命令会重启/中断正在运行的服务，守卫要求「本轮用户消息里明确授权」。${echo} —— 里面没有重启/授权之意 ⇒ 不得执行。先说明重启什么、为什么、怎么回退，等用户回话（R-03/R-12）。`;
}

/**
 * 标点/符号/空白/表情/控制符（数字**不剥**：`123` 是能指到动作的输入）。
 * 剥完之后只剩汉字/假名/字母/数字才算「解析得出动作」。
 */
const NON_ACTION_CHARS = /[\p{P}\p{S}\p{Z}\p{M}\p{C}]/gu;
const ACTION_CHARS = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}A-Za-z0-9]/u;

/** 本轮用户消息能不能解析出动作（剥掉标点/符号/空白/表情后还剩 CJK 或 ASCII 字母数字）。 */
export function isParsableUserText(userText) {
  const u = String(userText ?? "");
  if (!u) return true;                       // 本轮没有消息记录 ⇒ 不作判据（见 unparsableGate）
  return ACTION_CHARS.test(u.replace(NON_ACTION_CHARS, ""));
}

/**
 * 不可解析输入闸：返回拒绝理由或 undefined。纯函数，可单测，状态一律按 agent（无全局单例）。
 * 规则（2026-10-22 用户裁决，逐字）：解析不出动作的输入 = 缺口——既不是指令，也不是批准，也不是"继续"。
 *   · mutating=false ⇒ 一律放行（只读调用不拦）
 *   · 本轮取不到用户消息（空串）⇒ 放行：本会话没有本轮记录时不得凭空拦，否则自动续跑轮被卡死
 *   · 不可解析且 mutating=true ⇒ 拒绝，并逐字回显本轮消息（照 restartGate 的 echo 写法）
 */
export function unparsableGate({ userText = "", mutating = false, enabled = true } = {}) {
  if (!enabled) return undefined;
  if (!mutating) return undefined;
  const u = String(userText ?? "");
  if (!u) return undefined;
  if (isParsableUserText(u)) return undefined;
  const echo = u ? `本轮用户消息（逐字）：${JSON.stringify(u.slice(0, 300))}`
                 : "本轮用户消息：本回合取不到（pre-step 未捕获）";
  return `【不可解析输入＝缺口】${echo} —— 剥掉标点/符号/空白/表情后没有剩下任何汉字或字母数字，解析不出动作。`
    + "按已定规则：这类输入**不是指令、不是批准、也不是「继续」**，不得当作本次改盘的授权（R-03）。\n"
    + "**只准回问**：把「改哪个文件 / 跑哪条命令、代价与回退」写清楚，问一次，等用户回话；本轮不许动盘。\n"
    + "要放行本次写盘，需要本轮用户消息里有明确授权词，**且能指到具体动作**；上一轮或更早的授权不结转。\n"
    + "需要引用用户原话时用 `session_facts`（harness 记录的逐字文本 + 回合号），不许凭记忆复述（R-13）。";
}

function lockFile() {
  return `${process.env.HOME || "/home/loong"}/.dsh/arbitrate/window.lock`;
}

/** 读窗口锁：pid 还活着才算「有窗口在跑」，否则视为陈旧。 */
export function liveWindow(path = lockFile()) {
  try {
    const j = JSON.parse(readFileSync(path, "utf8"));
    const pid = Number(j?.pid);
    if (!Number.isInteger(pid) || pid <= 0) return null;
    try { process.kill(pid, 0); } catch { return null; }   // 进程已死 ⇒ 陈旧
    return { pid, label: String(j?.label || ""), at: Number(j?.at || 0) };
  } catch { return null; }
}

const DETACHED_RE = /\b(setsid|nohup|disown)\b|(^|\s)&(\s|$)/;

/** 并行闸：已有活窗口时，禁止再起 detached 重活。纯函数，可单测。 */
export function parallelGate({ cmd = "", window = null, enabled = true } = {}) {
  if (!enabled || !window) return undefined;
  if (!DETACHED_RE.test(cmd)) return undefined;
  return `【本机单序列】已有一个重活窗口在跑（${window.label || "未标注"} pid=${window.pid}）。并行第二个窗口只会互相抢显存/内存，不会更快——本机只有一条推理序列。先等它结束（或看 arbitrate_status），再起下一个。`;
}

/** Windows 脚本后缀 */
const PS_EXT = /\.(ps1|bat|cmd)$/i;
/** 同上但不锚定结尾：命令行里 .ps1 通常出现在中间 */
const PS_EXT_ANY = /\.(ps1|bat|cmd)\b/i;
/** 非 ASCII（含中文、全角标点） */
const NON_ASCII = /[^\x00-\x7F]/;
const PS1_HINT =
  "Windows 脚本里出现非 ASCII，且没有 UTF-8 BOM：PowerShell 5.1 读无 BOM 文件时不猜编码，" +
  "回落到系统 ANSI 代码页（中文 Windows = GBK/CP936）。UTF-8 的中文按 GBK 解 ⇒ 多字节与相邻字节粘连，" +
  "表现为「语法报错，但那一行看着完全没问题」，脚本根本没跑起来。三选一改掉：" +
  "① 正文只用 ASCII（注释改英文）；② 文件首字节加 UTF-8 BOM；③ 用 pwsh 7+。" +
  "依据 经验库/脚本被错误解码.md（本机 PS 5.1 无 BOM + 中文实测炸在最后一行）。";

/**
 * 编码闸：Windows 脚本含非 ASCII 且无 BOM ⇒ 拦。
 * 两种入口都要管：write/edit 的正文（path + content），以及 bash 里的重定向/heredoc（cmd）。
 */
export function ps1EncodingGate({ path = "", content = "", cmd = "", enabled = true } = {}) {
  if (!enabled) return undefined;
  if (path && PS_EXT.test(path) && NON_ASCII.test(String(content))) {
    let bom = String(content).startsWith("\uFEFF");
    if (!bom) { try { bom = readFileSync(path, "utf8").startsWith("\uFEFF"); } catch { /* 新文件，无 BOM */ } }
    if (!bom) return PS1_HINT;
  }
  if (cmd && PS_EXT_ANY.test(String(cmd)) && NON_ASCII.test(String(cmd))) {
    const writes = /(>>?\s*[^\s|;&]*|(^|[\s|;&])tee\b|\bSet-Content\b|\bOut-File\b|\bAdd-Content\b)/i.test(String(cmd));
    if (writes && !String(cmd).includes("\uFEFF")) return PS1_HINT;
  }
  return undefined;
}

const TRANSFER_RE = /(^|[\s;&|(])(scp|sftp|pscp)\b/i;
const REGISTER_RE = /\b(sc\s+(create|start|config|failure|description)|schtasks\s+\/create|net\s+start|New-Service)\b/i;

/**
 * 跨机联动闸：搬运与"注册/启动"串在一条 `&&` 里 ⇒ 拦。
 * 机理：`&&` 只传退出码；上游失败 ⇒ 下游整段被跳过且无人报告，而下游的成功回显
 * 会被当成"上游也成功了"（实测：scp 源路径写错 ⇒ 短路 ⇒ 服务注册成空路径）。
 */
export function chainedRemoteGate({ cmd = "", enabled = true } = {}) {
  if (!enabled || !cmd) return undefined;
  const s = String(cmd);
  if (!s.includes("&&")) return undefined;
  if (!TRANSFER_RE.test(s) || !REGISTER_RE.test(s)) return undefined;
  // 已有落地证据（对端 test -f）⇒ 放行：链里带了验证就不是"靠 && 传信任"
  if (/\btest\s+-[ef]\b/.test(s)) return undefined;
  return "跨机搬运与「注册/启动」串在一条 `&&` 里：`&&` 只传退出码，" +
    "上游失败时下游整段被静默跳过，而下游那步的成功回显会被当成'注册成功'（实测：scp 源路径写错 ⇒ " +
    "短路 ⇒ 服务注册成空路径，直到 `sc start` 才报'系统找不到指定的文件'）。改成分步、每步一个显式错误出口：\n" +
    '  [ -f "$SRC" ] || { echo "SRC MISSING"; exit 1; }\n' +
    '  scp "$SRC" "$HOST:$DST" || { echo "SCP FAILED"; exit 1; }\n' +
    '  ssh "$HOST" "test -f \'$DST\'" || { echo "DST MISSING"; exit 1; }\n' +
    '  ssh "$HOST" "<注册/启动>" || { echo "REGISTER FAILED"; exit 1; }\n' +
    "确需一行完成时，链里必须有落地证据（对端 `test -f`）。依据 经验库/链式短路.md。";
}

/**
 * 明文凭据闸：命令里直接写死密钥 ⇒ 拦。
 * 机理：命令原文会进会话日志（明文 JSONL）、`ps` 可见、子进程继承环境；
 * 而 vault 已经有免密 CLI，没有任何理由把明文写进命令行。
 */
export function inlineCredentialGate({ cmd = "", enabled = true } = {}) {
  if (!enabled || !cmd) return undefined;
  const s = String(cmd);
  const FORMS = [
    [/authorization:\s*(?:bearer|basic|token)\s+(?!\$)([A-Za-z0-9._~+\/=\-]{12,})/i, "Authorization 头里的字面令牌"],
    [/(^|[\s;&|(])sshpass\b[^|;&]*\s-p\s*(?!\$)(['"]?)([^\s'"]{3,})\2/, "sshpass -p 明文口令"],
    [/--password(?:=|\s+)(?!\$)(['"]?)([^\s'"]{4,})\1/, "--password 明文口令"],
    [/\/\/[^\/\s:@]+:[^\/\s@:]+@[^\/\s]/, "URL 里的 user:pass"],
    [/(^|[\s;])(?:export\s+)?([A-Za-z_]*(?:TOKEN|PASSWORD|SECRET|API_?KEY)[A-Za-z_]*)=(['"]?)(?!\$)[A-Za-z0-9._+\-\/]{8,}\3/i, "环境变量赋值里的明文凭据"],
  ];
  for (const [re, what] of FORMS) {
    if (re.test(s)) {
      return `命令里带明文凭据（${what}）：命令原文会进会话日志（明文 JSONL）、ps 可见、子进程继承环境。` +
        "改从 vault 取，明文不进对话也不进日志：\n" +
        "  dsh-vault list                  # 找条目（只列标题/用户名/主机，不含秘密）\n" +
        "  dsh-vault get <条目名>          # 取一个值，走管道给命令用\n" +
        "  dsh-vault env                   # 整组 env 条目一次拿\n" +
        "确需在本轮临时用时，把值放进变量再引用（`K=$(dsh-vault get …)`），不要写字面量。";
    }
  }
  return undefined;
}

/** 密钥文件读取闸：别去 .env / credentials.json / .netrc 里翻密钥。 */
export function secretFileGate({ cmd = "", enabled = true } = {}) {
  if (!enabled || !cmd) return undefined;
  const s = String(cmd);
  if (/\.env\.(example|sample|template)\b/.test(s)) return undefined;   // 模板文件不含真值
  // 读取类命令；`.` 单独判（`.` 当命令用时后面必须跟一个参数，避免把 `ls -l .env` 误当成 source）
  const reader = /(^|[\s;&|(])(cat|grep|rg|head|tail|less|more|awk|sed|source)\b/.test(s)
    || /(^|[\s;&|(])\.\s+\S/.test(s);
  if (!reader) return undefined;
  if (!/(\.env(\.[A-Za-z0-9_-]+)?\b|credentials\.json\b|\.netrc\b)/.test(s)) return undefined;
  return "不要从文件里找密钥（.env / credentials.json / .netrc）——文件里的密钥会进对话与日志。" +
    "vault 是唯一来源，且 CLI 已免密：\n" +
    "  dsh-vault list             # 找条目\n" +
    "  dsh-vault get <条目名>     # 取值\n" +
    "  dsh-vault env              # 整组\n" +
    "需要新建条目时用 vault_add（写库要你确认）。";
}

// ── 生成物静态检查（2026-10-22）：错误多半在被执行前就写在字节里 ───────────────
// 三档：off | log（只记日志，灰度默认）| deny。判据都在 exec 之前能算出，不依赖运行结果。
const SHELL_BUILTINS = new Set(["cd", "echo", "exit", "export", "unset", "set", "source", ".", ":", "true", "false", "test", "[", "[[", "]", "shift", "trap", "read", "local", "return", "wait", "kill", "printf", "eval", "exec", "if", "then", "else", "elif", "fi", "for", "while", "until", "do", "done", "case", "esac", "function", "time", "command", "type", "hash", "alias", "unalias", "pwd", "ulimit", "umask", "break", "continue", "declare", "typeset", "let", "mapfile", "readarray", "getopts", "shopt", "enable", "builtin", "dirs", "pushd", "popd", "jobs", "fg", "bg", "disown", "suspend", "logout", "history", "help", "caller", "compgen", "complete", "bind", "nl", "column", "readonly", "times"]);   // 2026-10-22 补：E 档判据点名的内建里原来缺 readonly / times

/**
 * 去掉引号内容与 heredoc 正文：远端命令与内联代码通常写在引号 / heredoc 里，
 * 误判它们 = 误杀。
 * 2026-10-22 修：旧版正则只吃单行引号，`python3 -c "` 后换行的多行脚本会被逐行
 * 当成命令（实测 6 分钟误杀 6 次：`try:` / `pass` / `EOF` / `l` …）。
 * 现在按字符扫描，引号可跨行；未闭合的引号吞到结尾（宁可少判，不可误杀）。
 */
function stripQuoted(s) {
  const src = String(s || "");
  let out = "";
  let i = 0;
  let q = null;
  while (i < src.length) {
    const c = src[i];
    if (q) {
      if (q === '"' && c === "\\" && i + 1 < src.length) { i += 2; continue; }
      if (c === q) { q = null; }
      i++;                       // 引号内的换行一并丢弃：那不是命令分隔符
      continue;
    }
    if (c === "'" || c === '"') { q = c; i++; continue; }
    out += c;
    i++;
  }
  return out;
}

/** 去掉 heredoc 正文（含结束符行）：`<<EOF` / `<<-'EOF'` 的正文不是命令 */
function stripHeredocs(s) {
  const lines = String(s || "").split("\n");
  const out = [];
  let delim = null;
  let stripTabs = false;
  for (const line of lines) {
    if (delim !== null) {
      const probe = stripTabs ? line.replace(/^\t+/, "") : line;
      if (probe.trimEnd() === delim) delim = null;
      continue;                                  // 正文与结束符都丢弃
    }
    const m = /<<(-?)\s*(?:'([^']*)'|"([^"]*)"|([A-Za-z_][A-Za-z0-9_]*))/.exec(line);
    if (m) {
      delim = m[2] ?? m[3] ?? m[4];
      stripTabs = m[1] === "-";
      out.push(line.slice(0, m.index));
      continue;
    }
    out.push(line);
  }
  return out.join("\n");
}

/** 命令名判定只看「引号外 + heredoc 外」的文本 */
function maskNonShell(s) {
  return stripQuoted(stripHeredocs(s));
}

/** A1 语法：`bash -n`（只解析不执行）。短单行不值得 spawn */
export function syntaxIssue(script = "") {
  const body = String(script || "");
  if (body.length < 40 && !body.includes("\n")) return undefined;
  const f = join(tmpdir(), `guard-syntax-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.sh`);
  try {
    writeFileSync(f, body, "utf8");
    const r = spawnSync("bash", ["-n", f], { encoding: "utf8", timeout: 5000 });
    if (r.status === 0) return undefined;
    const line = String(r.stderr || "").trim().split("\n").filter(Boolean).slice(0, 2).join(" / ");
    return `语法错（bash -n 未通过，尚未执行）：${line.slice(0, 220)}`;
  } catch { return undefined; } finally { try { unlinkSync(f); } catch { /* 已删或不存在 */ } }
}

/* ── shellcheck 适配器（2026-10-23 用户批准：bash 语法判据交给 shellcheck）────────
 * 实测（0.11.0，~/.local/bin/shellcheck，本轮复验）：
 *   `-s bash -S error` 对「函数名调用」「case 通配」「rm -rf /」「rm -rf "$dir"」
 *   「rm -rf ${d}/*」「mkdri /tmp/a」全部 0 条 ⇒ shellcheck 既不判破坏性形状、也不判命令存在性
 *   ⇒ 那两条判据保留自研（missingCommands / missingSourcePaths / 破坏性动词闸，一律不删）。
 *   不带 `-s bash` 时 `rm -rf /` 会多出 SC2148（level=error）⇒ 必带 `-s bash`（两版对照写进 README）。
 *   `-S warning` 对 `f=$1; echo $f; cd $x` 出 2154/2164 ⇒ warning 档只进台账。
 *   每次 spawn 实测 2ms；2 万行输入 4.5s ⇒ 有超时才敢在 guard 里同步调。
 * 降级形态（关键，不许静默）：路径不存在 / 不可执行 / spawn 失败 / 超时 / JSON 坏
 *   ⇒ 不报错、不拦，返回一条 rule:"shellcheck-missing" 的 W，接线处把「语法判据本轮失明」
 *   写进工具返回文案（让模型看见），台账行带 notices。
 * 状态按调用隔离：这里没有任何模块级缓存/单例，每次调用独立 spawn。
 */
const SHELLCHECK_LEVEL_TIER = { error: "E", warning: "W", info: "W", style: "W" };
const SHELLCHECK_SEVERITIES = new Set(["error", "warning", "info", "style"]);
/** 以下两句是「显式降级」的固定文案（拒绝文案里必须出现，不能只进台账） */
export const SHELLCHECK_MISSING_NOTICE = "shellcheck 未就绪（路径/权限），语法判据本轮失明（已回退 `bash -n` 兜底）——这不是「已检查通过」";
export const PWSH_NO_PARSER_NOTICE = "pwsh 无语法解析器，本轮语法判据未参与检查（非通过）";

function shellcheckReady(p) {
  if (!p) return false;
  try { accessSync(String(p), constants.X_OK); return statSync(String(p)).isFile(); } catch { return false; }
}

function shellcheckMissingIssue(reason) {
  const message = `shellcheck 未就绪（${reason}），语法判据本轮失明`;
  return { rule: "shellcheck-missing", tier: "W", message, text: `语法判据未判（shellcheck 缺失）：${message}` };
}

/** 一次 shellcheck 求值：stdin 喂脚本（不写临时文件）。返回 { issues, excluded, available, reason }
 *  入参名与配置项同名（shellcheckPath / shellcheckSeverity / shellcheckExclude / shellcheckTimeoutMs）
 *  —— 名字对不上就是「配置改了不生效」的经典形状，本轮实测踩过一次（改完复验：exclude 生效）。 */
export function shellcheckScan({
  script = "", shellcheckPath = DEFAULTS.shellcheckPath,
  shellcheckSeverity = DEFAULTS.shellcheckSeverity, shellcheckExclude = DEFAULTS.shellcheckExclude,
  shellcheckTimeoutMs = DEFAULTS.shellcheckTimeoutMs,
} = {}) {
  const body = String(script || "");
  const sev = SHELLCHECK_SEVERITIES.has(String(shellcheckSeverity || "").toLowerCase()) ? String(shellcheckSeverity).toLowerCase() : "error";
  const drop = new Set((Array.isArray(shellcheckExclude) ? shellcheckExclude : [])
    .map((c) => String(c).trim().toUpperCase()).filter(Boolean));
  const ms = Number(shellcheckTimeoutMs) > 0 ? Math.min(Number(shellcheckTimeoutMs), 60000) : DEFAULTS.shellcheckTimeoutMs;
  if (!shellcheckReady(shellcheckPath)) {
    return { issues: [shellcheckMissingIssue("路径/权限")], excluded: [], available: false, reason: "not-ready" };
  }
  let r = null;
  try {
    r = spawnSync(String(shellcheckPath), ["-s", "bash", "-f", "json", "-S", sev, "-"],
      { input: body, timeout: ms, encoding: "utf8" });
  } catch (e) {
    return { issues: [shellcheckMissingIssue(`spawn 抛错 ${String(e?.message || "").slice(0, 60)}`)], excluded: [], available: false, reason: "spawn-throw" };
  }
  if (!r || r.status === null || r.status === undefined) {
    const code = String((r && r.error && r.error.code) || (r && r.signal) || "unknown");
    // 缺口3（实测）：5000ms 撞过线——2 万行脚本 shellcheck 4.5s 是常态量级 ⇒ 默认抬到 15000。
    // 撞线文案必须写清「超时 Ns」与新默认值，否则现场只看到 spawn 失败，查不到是撞了线。
    const timedOut = code === "ETIMEDOUT" || code === "SIGTERM" || code === "SIGKILL";
    const secs = ms < 1000 ? (ms / 1000).toFixed(2) : String(Math.round(ms / 1000));   // 亚秒预算别写成「超时 0s」
    const why = timedOut
      ? `超时 ${secs}s（shellcheckTimeoutMs=${ms}，本轮默认已抬到 ${DEFAULTS.shellcheckTimeoutMs}）`
      : `spawn 失败 ${code}`;
    return { issues: [shellcheckMissingIssue(why)], excluded: [], available: false, reason: timedOut ? "timeout" : "spawn-fail" };
  }
  let raw = null;
  try { raw = JSON.parse(String(r.stdout || "").trim() || "[]"); } catch { raw = null; }
  if (!Array.isArray(raw)) {
    return { issues: [shellcheckMissingIssue("输出不是 JSON 数组")], excluded: [], available: false, reason: "bad-json" };
  }
  const issues = [], excluded = [];
  for (const it of raw) {
    const code = Number(it && it.code) || 0;
    const key = `SC${code}`;
    // 剔除按整脚本生效（逐 code 判，不按行）；剔除本身在台账 excluded 留痕
    if (drop.has(key) || drop.has(String(code))) { if (!excluded.includes(key)) excluded.push(key); continue; }
    const tier = SHELLCHECK_LEVEL_TIER[String((it && it.level) || "").toLowerCase()] || "W";
    const line = Number(it && it.line) || 0, col = Number(it && it.column) || 0;
    const message = String((it && it.message) || "").trim();
    issues.push({
      rule: "syntax", tier, code, line, col, message,
      text: `${tier === "E" ? "语法错" : "语法提示（shellcheck W 档·只记台账）"}：SC${code} 行${line}:${col} ${message}`,
    });
  }
  return { issues, excluded, available: true, reason: "" };
}

/** bash 语法判据（交给 shellcheck）⇒ [{rule:'syntax', tier, code, line, col, message}]。
 *  未就绪时返回一条 {rule:'shellcheck-missing', tier:'W'}（显式降级，不静默、不报错、不拦）。
 *  四个覆盖项的名字与配置项逐字同名；不传就走 DEFAULTS。 */
export function shellcheckIssues({
  script = "", shellcheckPath = DEFAULTS.shellcheckPath,
  shellcheckSeverity = DEFAULTS.shellcheckSeverity, shellcheckExclude = DEFAULTS.shellcheckExclude,
  shellcheckTimeoutMs = DEFAULTS.shellcheckTimeoutMs,
} = {}) {
  return shellcheckScan({ script, shellcheckPath, shellcheckSeverity, shellcheckExclude, shellcheckTimeoutMs }).issues;
}

/** 多条语法 E 折叠成一条（台账 codes 记全部码）；沿用原判据「语法先命中 ⇒ 不叠后两项」 */
function syntaxAggregate(es, label) {
  const codes = [...new Set(es.map((i) => i && i.code).filter(Boolean))];
  const head = es[0] || {};
  const tag = (c) => (Number(c) > 0 ? `SC${c}` : String(c || ""));
  const detail = es.slice(0, 4).map((i) => `${tag(i.code)} 行${i.line}:${i.col} ${i.message}`).join(" / ");
  return {
    rule: "syntax", tier: "E", codes, line: head.line || 0, col: head.col || 0,
    text: `语法错（${label}，尚未执行）：${detail}`.slice(0, 320),
  };
}

/* ── pwsh 语法解析器装载（2026-10-23 缺口修复：pwsh 上真判据）──────────────────────
 * 实测路线（本机 Node v22.22.2；包已装：tree-sitter@0.25.1 + tree-sitter-powershell@0.26.4）：
 *   `require("tree-sitter-powershell")` ⇒ 抛 ERR_REQUIRE_ASYNC_MODULE（本轮复验，逐字输出
 *     "require powershell THROW ERR_REQUIRE_ASYNC_MODULE"）⇒ **禁止 require，只能动态 import()**。
 *   `import("tree-sitter")` + `import("tree-sitter-powershell")` ⇒ `new Parser(); setLanguage(gram)` 可用。
 *   解析形状（本轮复验，逐字见 test/pwsh-parser.mjs 与交付报告）：
 *     坏 `$x = 1 +\nif ( \nWrite-Host "hi`  ⇒ rootNode.type=ERROR、ERROR 节点 2 个
 *     合法 `$x = Get-Process | Where-Object { $_.CPU -gt 1 }\nWrite-Output $x` ⇒ rootNode.type=program、0 个
 *   装载耗时实测 24ms（同一次 probe 里打印的 load_ms）。
 *   解析器只能从插件自己所在目录解析（模块解析按 import 发起文件的目录找 node_modules）：
 *     实测在 /tmp 下 import("tree-sitter") ⇒ ERR_MODULE_NOT_FOUND；插件目录里同一行 ⇒ 成功。
 * 装载时机 = **懒加载 + 模块级 promise 缓存**（不用 ESM 顶层 await），三条理由：
 *   1) 顶层 await 把整份插件的加载变成异步 ⇒ 宿主加载插件那条路径被我们拖住，连不碰 pwsh 的调用也陪绑；
 *   2) 顶层 await 没有配置能关掉（宿主 Config schema 严格：实测多一个键 ⇒ 整份插件配置校验失败）；
 *   3) 懒加载只在第一次 pwsh 调用时装，实测 24ms，且天然被 pwshParser 门控（off ⇒ 连 import 都不发）。
 *   插件加载阶段只做一次「预约」（apply 里 fire-and-forget，不 await）⇒ 宿主启动不被 import 拖住。
 * 超时保护：import 用 `Promise.race` + setTimeout 挂预算（默认 pwshLoadBudgetMs=2000ms，上限 15s），
 *   超时 ⇒ 缓存成失败 ⇒ 显式降级 W（不是通过）；import 真落地时撤掉定时器，定时器 unref ⇒ 不挂住事件循环。
 *   （不用 node:child_process 的 finished()：本机 Node v22.22.2 实测 `import { finished } from "node:child_process"`
 *     ⇒ SyntaxError: does not provide an export named 'finished'；`stream.finished` 实测不收 Promise ⇒ 自己写计时。）
 * 为什么这份缓存不算 per-agent 状态（对照「状态按 agent 隔离，禁止新增模块级全局单例」）：
 *   缓存里只有**只读装载产物**——两个模块引用 + 取到的 Parser 构造函数；解析是纯函数（每次调用
 *   new 一个 Parser、parse 出独立 tree，写入只发生在该次调用的局部 tree 上），缓存里没有 agent 身份、
 *   没有计数、没有历史。真正可变的 per-agent 状态仍然一律按 agent 键（stOf / counts / lastMut）。
 *   失败同样缓存：装载失败若每次调用重试，等于每次 pwsh 调用都付一遍 2s 预算。
 */
const PWSH_LOAD_BUDGET_MS = DEFAULTS.pwshLoadBudgetMs;
let pwshLoader = null;   // null=没发过 | {pending:true} | {available:true,Parser,language} | {available:false,reason}

function pwshLoadFailure(reason) { pwshLoader = { available: false, reason }; return pwshLoader; }

/** 发起（或复用）一次装载。budgetMs=import 超时预算；force=true 忽略 pwshParser 开关（测试预热 / apply 预约用）。 */
export function ensurePwshParser(pwshParser = DEFAULTS.pwshParser, { budgetMs = PWSH_LOAD_BUDGET_MS, force = false } = {}) {
  if (pwshLoader && !force) return pwshLoader;
  if (!force && String(pwshParser || "off").toLowerCase() !== "auto") return pwshLoadFailure("config off");
  // 预算 ≤0 ⇒ 不装载，直接判"未就绪"（显式降级，不是通过）。这条也是超时分支的确定性入口：
  //   真 import 在热进程里可能比 1ms 计时器先到（本机实测装载 24ms 是冷进程数字），计时器测试会飘。
  if (!(Number(budgetMs) > 0)) return pwshLoadFailure(`装载预算 ${budgetMs}ms（未装载，非通过）`);
  const ms = Math.min(Number(budgetMs), 15000);
  let timer = null;
  // 一次装载尝试 ⇒ 一个结论，不反悔：只有还在 pending 时才落状态。
  // 超时判成"未就绪"之后，迟到的 import 落地不把状态翻回可用（判定过的那一轮不能事后追认 ⇒ 台账/文案对得上现场）；
  // 要恢复判据就显式 force 重装（测试与预热走这条路）。
  const commit = (next) => { if (pwshLoader && pwshLoader.pending) pwshLoader = next; return pwshLoader; };
  pwshLoader = { pending: true };
  const work = Promise.all([import("tree-sitter"), import("tree-sitter-powershell")])
    .then(([tsMod, gramMod]) => {
      // 模块形状（本机实测 tree-sitter@0.25.1 的 ESM namespace）：
      //   keys = LookaheadIterator,Query,SyntaxNode,Tree,TreeCursor,default；
      //   typeof default === "function"（default 就是 Parser 类本身）、default.Parser 与 Parser 都是 undefined
      //   ⇒ 认法：default 是函数就当 Parser；否则退到 named export Parser；再退到 default.Parser。
      const Parser = (typeof tsMod?.default === "function" ? tsMod.default : null)
        || (typeof tsMod?.Parser === "function" ? tsMod.Parser : null)
        || (typeof tsMod?.default?.Parser === "function" ? tsMod.default.Parser : null);
      const language = (gramMod && gramMod.default) || gramMod;
      if (typeof Parser !== "function" || !language) throw new Error("模块形状不认识：Parser / language 取不到");
      return commit({ available: true, Parser, language });
    })
    .catch((e) => commit({ available: false, reason: `解析器求值失败 ${String((e && (e.code || e.message)) || e).slice(0, 80)}` }));
  const timeout = new Promise((res) => {
    timer = setTimeout(() => res(pwshLoadFailure(`解析器装载超时 ${ms}ms（未装载，非通过）`)), ms);
    if (timer && timer.unref) timer.unref();   // 定时器不挂住事件循环（宿主进程退出不该等它）
  });
  const raced = Promise.race([work, timeout]);
  const clear = () => { if (timer) clearTimeout(timer); };   // import 真落地（成功或失败）⇒ 撤掉定时器
  work.then(clear, clear);
  void raced.catch(() => {});
  pwshLoader = { pending: true };
  return pwshLoader;
}

/** 内部状态（含装载产物）：pwshSyntaxIssues 用它拿 Parser/language。 */
function pwshParserState(pwshParser = DEFAULTS.pwshParser) {
  const mode = String(pwshParser || "off").toLowerCase();
  if (mode !== "auto") return { available: false, reason: "config off" };
  const st = ensurePwshParser("auto");
  if (st && st.pending) return { available: false, reason: "解析器装载中（未就绪，非通过）" };
  return st && st.available
    ? { available: true, reason: "", Parser: st.Parser, language: st.language }
    : { available: false, reason: (st && st.reason) || "解析器未就绪" };
}

/** pwsh 装载状态（同步读缓存：不 spawn、不 await、不阻塞调用方）。公开形状只有 {available, reason}。 */
export function pwshParserStatus(pwshParser = DEFAULTS.pwshParser) {
  const s = pwshParserState(pwshParser);
  return { available: s.available, reason: s.reason };
}

function pwshNoParserIssue(reason) {
  const message = `pwsh 无语法解析器（${reason}），本轮语法判据未参与检查（非通过）`;
  return { rule: "pwsh-no-parser", tier: "W", message, text: message };
}

/** 真判据（同步使用已装载的模块引用）：ERROR / MISSING 节点 ⇒ E，逐条带节点类型与行列（取前 4 个）。
 *  装载未就绪 / 求值或解析本身抛错 ⇒ 一律显式降级成 pwsh-no-parser W，**绝不把「解析器坏了」算成通过**。 */
export function pwshSyntaxIssues({ script = "", pwshParser = DEFAULTS.pwshParser } = {}) {
  const st = pwshParserState(pwshParser);
  if (!st.available) return { available: false, issues: [pwshNoParserIssue(st.reason)] };
  try {
    const parser = new st.Parser();
    parser.setLanguage(st.language);
    const tree = parser.parse(String(script || ""));
    const found = [];
    const walk = (node) => {
      if (!node) return;
      if (node.type === "ERROR" || node.type === "MISSING") {
        found.push({
          type: node.type,
          line: Number(node?.startPosition?.row ?? 0) + 1,
          col: Number(node?.startPosition?.column ?? 0) + 1,
          snippet: String(node.text || "").replace(/\s+/g, " ").slice(0, 60),
        });
      }
      const n = Number(node?.namedChildCount ?? node?.childCount ?? 0);
      for (let i = 0; i < n; i++) { let c = null; try { c = node.child(i); } catch { c = null; } walk(c); }
    };
    walk(tree && tree.rootNode);
    try { tree?.destroy?.(); parser.delete?.(); } catch { /* 版本差异：释放失败不影响判定 */ }
    return {
      available: true,
      issues: found.map((f) => ({
        rule: "syntax", tier: "E", code: "TS-ERROR", nodeType: f.type, line: f.line, col: f.col,
        // message 不重复写行列（折叠成一条时 syntaxAggregate 会拼「TS-ERROR 行:列」在前）
        message: `PowerShell 解析出现 ${f.type} 节点：${f.snippet}`,
        text: `语法错（tree-sitter-powershell，尚未执行）：${f.type} 节点 行${f.line}:${f.col} ${f.snippet}`,
      })),
    };
  } catch (e) {
    return { available: false, issues: [pwshNoParserIssue(`解析器求值失败 ${String(e?.message || "").slice(0, 60)}`)] };
  }
}

function commandExists(word) {
  if (!word) return true;
  for (const d of String(process.env.PATH || "").split(":")) {
    if (!d) continue;
    try { accessSync(join(d, word), constants.X_OK); return true; } catch { /* 继续找 */ }
  }
  return false;
}

/** A3 命令存在性：段首命令词在 PATH 里查不到 ⇒ 多半拼错 */
export function missingCommands(script = "") {
  const out = new Set();
  for (const seg of maskNonShell(script).split(/&&|\|\||;|\||\n|\(|\)/)) {
    const t = seg.trim().split(/\s+/)[0];
    if (!t || t.includes("/") || t.includes("=") || /[$`]/.test(t)) continue;
    const w = t.replace(/^["']|["']$/g, "");
    if (!w || w.startsWith("-") || SHELL_BUILTINS.has(w)) continue;
    // 纯标点不是命令：花括号组 `{ ... }`、`!` 取反、`(` 子 shell 等（2026-10-22 误杀 `{`/`}`）
    if (/^[{}()[\];,|&<>!$#*~]+$/.test(w)) continue;
    if (!commandExists(w)) out.add(w);
  }
  return [...out].map((w) => `命令不存在：${w}（PATH 里查不到，多半拼错）`);
}

/** A2 源路径存在性（最窄版）：只查 scp/cp 的**绝对字面源**，且父目录存在、文件不存在 */
export function missingSourcePaths(script = "") {
  const out = [];
  for (const seg of maskNonShell(script).split(/&&|\|\||;|\n/)) {
    const parts = seg.trim().split(/\s+/);
    if (parts[0] !== "scp" && parts[0] !== "cp") continue;
    const args = parts.slice(1).filter((a) => a && !a.startsWith("-"));
    if (args.length < 2) continue;
    for (const s of args.slice(0, -1)) {          // 最后一个永远是目标
      if (s.includes(":") || s.includes("$")) continue;          // 远端 host:path / 变量
      if (/[*?[\]{}]/.test(s) || s.startsWith("~")) continue;    // 通配 / 家目录
      if (!s.startsWith("/")) continue;                          // 只认绝对字面
      if (existsSync(s)) continue;
      let parentOk = false;
      try { parentOk = statSync(dirname(s)).isDirectory(); } catch { parentOk = false; }
      if (!parentOk) continue;       // 父目录都不在 ⇒ 可能还没创建，不冒判
      out.push(`源路径不存在：${s}（父目录在、文件不在 ⇒ 多半路径写错，不是还没生成）`);
    }
  }
  return out;
}

/** 汇总（空数组 = 没发现问题）。语法不过就不再做后两项，免得噪声压住真错 */
export function staticCheckIssues({ script = "" } = {}) {
  const syn = syntaxIssue(script);
  if (syn) return [syn];
  return [...missingCommands(script), ...missingSourcePaths(script)];
}
/* ── 分级放行（2026-10-22 用户批准：分级放行 + 行内豁免 + 可标误报）──────────────
 * 台账实况（2026-10-22，~/.dsh/static-check.jsonl 实测 25 行，全 mode=deny、全 tool=bash）：
 *   命令不存在 66 / 源路径不存在 3 / 语法 0；本轮已证实两类误报——
 *   ① 脚本里自己定义的 shell 函数被当命令（`命令不存在：check`）；
 *   ② case 分支的通配模式被当命令（`*R-11-cleanup-and-shrink.md`、`*快照*`）。
 * ⇒ 「命令不存在」从此不是"看到即拦"的判据：只有 E 档（形状判据逐条全满足）才允许拦，
 *   其余形态一律 W 档——W 只落台账，mode 是 log 还是 deny 都不拦。
 */
export const STATIC_RULES = new Set(["syntax", "command-missing", "path-missing"]);

/** 命令词的可拦字面形态：纯字面，不含 $ * ? 引号 花括号 斜杠 */
const STATIC_LITERAL_CMD = /^[A-Za-z][A-Za-z0-9._-]*$/;

/** shell 关键字：`case x in` 的 x、`for i in` 的 i 都落在 argv0 位上，但它们不是命令 */
const SHELL_KEYWORDS = new Set(["if", "then", "else", "elif", "fi", "for", "while", "until",
  "do", "done", "case", "esac", "in", "select", "function", "time", "coproc"]);

/** PATH 之外还要查一遍的常见落点：全查无才允许 E（PATH 被裁剪是已知误报来源） */
const STATIC_FIXED_DIRS = ["bin", "usr/bin", "usr/local/bin", "sbin", "usr/sbin", ".local/bin"];
function staticDirHasExecutable(word) {
  for (const d of STATIC_FIXED_DIRS) {
    const p = d.startsWith(".") ? join(homedir(), d, word) : join("/", d, word);
    try { accessSync(p, constants.X_OK); return true; } catch { /* 继续找下一个 */ }
  }
  return false;
}

/** 行内豁免：`# guard: allow <rule> <原因>`；原因去空白后 <3 字符 ⇒ 豁免无效 */
const GUARD_ALLOW_RE = /#\s*guard:\s*allow\s+([A-Za-z-]+)\s*([\s\S]*)$/;

/** 只扫描不执行。带 4 个上下文标记：argv0 / case 模式位 / 括号深度 / probe 参数位 */
function staticShellTokens(masked) {
  const out = [];
  let paren = 0, caseDepth = 0, expectIn = false, patPos = false, argv0 = true;
  for (const line of String(masked || "").split("\n")) {
    const chunks = line.replace(/([()|;&<>])/g, " $1 ").split(/\s+/).filter(Boolean);
    const toks = [];
    for (const c of chunks) {   // 相邻控制符合并成一个 token（&& ;; ;;& 2>）
      const prev = toks.length ? toks[toks.length - 1] : "";
      if (/^[()|;&<>]+$/.test(c) && /^[()|;&<>]+$/.test(prev)) toks[toks.length - 1] = prev + c;
      else toks.push(c);
    }
    const probe = new Set();    // `command -v X` / `type X` / `hash X` 的参数位
    for (let i = 0; i < toks.length; i++) {
      const isCmdV = toks[i] === "command" && toks[i + 1] && /^-\w+$/.test(toks[i + 1]);
      const isTypeHash = (toks[i] === "type" || toks[i] === "hash") && !/^[-<>&|();]/.test(toks[i - 1] || "");
      if (!isCmdV && !isTypeHash) continue;
      for (let j = i + (isCmdV ? 2 : 1); j < toks.length; j++) {
        if (/^[-<>&|();]/.test(toks[j])) break;
        probe.add(j);
      }
    }
    for (let i = 0; i < toks.length; i++) {
      const t = toks[i];
      if (/^[()|;&<>]+$/.test(t)) {
        for (const ch of t) { if (ch === "(") paren++; else if (ch === ")") paren = Math.max(0, paren - 1); }
        if (t === "&&" || t === "||" || t === "|" || t.includes(";")) argv0 = true;
        if (t.includes("(")) argv0 = true;   // 子 shell / $() 也是命令边界：内部词元按 argv0 收，但 paren>0 ⇒ 只给 W
        if (caseDepth > 0 && /^(;;|;&|;;&)$/.test(t)) patPos = true;
        continue;
      }
      const isPat = caseDepth > 0 && patPos;
      out.push({ tok: t, argv0, isPat, paren, probe: probe.has(i) });
      if (t === "case") { expectIn = true; argv0 = false; continue; }
      if (expectIn && t === "in") { caseDepth++; expectIn = false; patPos = true; argv0 = true; continue; }
      if (t === "esac") { caseDepth = Math.max(0, caseDepth - 1); patPos = false; argv0 = false; continue; }
      if (isPat) patPos = false;
      argv0 = false;            // 关键字与参数之后的词不在 argv0 位
    }
    argv0 = true;               // 换行 = 命令分隔符
  }
  return out;
}

/** 本脚本里自己定义的函数名（`NAME()` / `function NAME`）——这类词元不是外部命令 */
function staticDefinedNames(masked) {
  const names = new Set();
  const src = String(masked || "");
  for (const m of src.matchAll(/(^|[\s;&|(])([A-Za-z_][A-Za-z0-9._-]*)\s*\(\s*\)/g)) names.add(m[2]);
  for (const m of src.matchAll(/\bfunction\s+([A-Za-z_][A-Za-z0-9._-]*)/g)) names.add(m[1]);
  return names;
}

/** heredoc 正文行（mask 已把它们从命令流里剥掉；这里取回来只为记 W 档） */
function staticHeredocBodies(script) {
  const bodies = [];
  let delim = null, stripTabs = false;
  for (const line of String(script || "").split("\n")) {
    if (delim !== null) {
      const probe = stripTabs ? line.replace(/^\t+/, "") : line;
      if (probe.trimEnd() === delim) { delim = null; continue; }
      bodies.push(line);
      continue;
    }
    const m = /<<(-?)\s*(?:'([^']*)'|"([^"]*)"|([A-Za-z_][A-Za-z0-9_]*))/.exec(line);
    if (m) { delim = m[2] ?? m[3] ?? m[4]; stripTabs = m[1] === "-"; }
  }
  return bodies;
}

/** 整段就是引号载荷的形态（ssh host '…' / bash -c "…"）：载荷里的动词在远端跑，本机 PATH 查无属正常 */
function staticQuotedPayloadWords(script) {
  const words = [];
  const src = String(script || "");
  for (const m of src.matchAll(/'([^']*)'|"([^"]*)"/g)) {
    const before = src.slice(0, m.index);
    const prefix = before.slice(before.lastIndexOf("\n") + 1).trim();
    const atArg0 = prefix === "" || /[;&|]$/.test(prefix) || /(-c|-command)\s*$/.test(prefix)
      || /^\s*(sudo\s+)?(ssh|sshpass|scp|sh|bash|zsh|pwsh)\b[^;&|]*$/.test(prefix);   // 载体必须在行首（2026-10-22：原来用 \b 匹配会被 /tmp/a.sh 里的 sh 骗到，把 heredoc 的 'EOF' 记成引号载荷）
    if (!atArg0) continue;      // 引号在 argv1 之后 ⇒ 是参数不是命令，不记
    for (const seg of String(m[1] ?? m[2] ?? "").split(/&&|\|\||;|\||\n/)) {
      const w = seg.trim().split(/\s+/)[0];
      if (w) words.push(w);
    }
  }
  return words;
}

/** 命令存在性·分级版：E 的形状判据逐条写死，任一条不满足 ⇒ W（并写明是哪一条） */
export function staticCommandIssuesDetailed({ script = "", shell = "bash", nonShellLang = false } = {}) {
  const masked = maskNonShell(script);
  const defined = staticDefinedNames(masked);
  const known = (w) => commandExists(w) || staticDirHasExecutable(w);
  const out = [];
  const seen = new Set();
  const record = (word, tier, reason) => {
    const key = tier + "\0" + word;
    if (seen.has(key)) return;
    seen.add(key);
    out.push({
      rule: "command-missing", tier,
      text: tier === "E"
        ? `命令不存在：${word}（PATH 里查不到，多半拼错）`
        : `命令不存在（W 档·只记台账，不拦）：${word}（${reason}）`,
    });
  };
  for (const t of staticShellTokens(masked)) {
    const w = t.tok;
    if (!t.argv0 || SHELL_BUILTINS.has(w) || SHELL_KEYWORDS.has(w)) continue;
    // 不记档的形态：旗标 `-x`、赋值 `A=b`、纯标点 `{ } ;`、纯符号（台账里 { } ' 那批噪声）
    if (/^[-<>&|]/.test(w) || w.includes("=") || !/[A-Za-z0-9]/.test(w)) continue;
    if (known(w)) continue;
    const literal = STATIC_LITERAL_CMD.test(w);
    if (!nonShellLang && shell === "bash" && literal && !defined.has(w) && !t.isPat && !t.probe && t.paren === 0) {
      record(w, "E", "");
      continue;
    }
    const reason = nonShellLang ? "非 bash 脚本（shebang 指定解释器）：行首词不是要执行的命令，argv0 语义不适用"
      : shell !== "bash" ? "非 bash 解释器：命令名不按本机 PATH 判"
      : defined.has(w) ? "本脚本里定义的函数（NAME() / function NAME）"
      : t.isPat ? "case 分支的模式位"
      : t.probe ? "command -v / type / hash 的参数位"
      : t.paren > 0 ? "子 shell 括号内部"
      : "非字面词元（变量展开 / 通配 / 引号残留 / 带斜杠路径）";
    record(w, "W", reason);
  }
  for (const line of staticHeredocBodies(script)) {   // heredoc 正文：过去会被匹配到的形态 ⇒ W
    const w = line.trim().split(/\s+/)[0];
    if (!w || SHELL_BUILTINS.has(w) || !/[A-Za-z0-9]/.test(w) || /^[-{}()\[\];,.:~#*'"]/.test(w) || known(w)) continue;
    record(w, "W", "heredoc 正文（写进文件的内容，不是本机要执行的命令）");
  }
  for (const w of staticQuotedPayloadWords(script)) {
    if (SHELL_BUILTINS.has(w) || !STATIC_LITERAL_CMD.test(w) || known(w)) continue;
    record(w, "W", "引号载荷（在远端/子 shell 里执行，本机 PATH 查无属正常）");
  }
  return out;
}

/** 源路径存在性·分级版：判据本来就保守（绝对字面 + 父目录在 + 文件不在），记 E */
export function staticPathIssues(script = "") {
  return missingSourcePaths(script).map((text) => ({ rule: "path-missing", tier: "E", text }));
}

/** shebang 解释器白名单（2026-10-23 缺口1）：这些形态照旧交给 shellcheck，其余跳过。
 *  只认「解释器路径的基名」，旗标不参与判定：实测 `#!/usr/bin/env -S bash -eu` 基名是 env、真解释器是 bash。 */
const SHEBANG_BASH_INTERPRETERS = new Set(["sh", "bash", "dash", "zsh", "ksh", "env"]);

/** 首行 shebang 且解释器不在白名单 ⇒ { interp }（喂给 `shellcheck -s bash` 出的是噪声，不是脚本的错）；
 *  无 shebang / shebang 是 bash 系 ⇒ null（照旧交给 shellcheck）。
 *  实测：`#!/usr/bin/env python3` + `print(1` 喂 `-s bash -S error` ⇒ SC1036/SC1088/SC1065 三条 error（全是噪声）。
 *  `#!/usr/bin/env bash` / `#!/bin/bash` ⇒ 白名单内；`#!/usr/bin/env python3` ⇒ {interp:"env python3"}；
 *  `#!/usr/bin/env`（后面没东西）⇒ null：判不出真解释器，宁可照旧跑 shellcheck，不猜。 */
export function nonBashShebang(script = "") {
  const first = String(script || "").split("\n", 1)[0];
  if (!first.startsWith("#!")) return null;
  const toks = first.slice(2).trim().split(/\s+/).filter(Boolean);
  if (!toks.length) return null;
  const base = (t) => basename(String(t).replace(/\\/g, "/"));
  const head = base(toks[0]);
  if (!SHEBANG_BASH_INTERPRETERS.has(head)) return { interp: head };
  if (head === "env") {
    // env 形态要看它后面的那个真解释器：`env python3` ⇒ python3；`env -S bash -eu` ⇒ bash（旗标不参与）。
    // 注意必须从 env 之后找（实测：在整行 find 会把 "/usr/bin/env" 自己当成真解释器 ⇒ 白名单判断永远命中）
    const real = toks.slice(1).find((t) => !String(t).startsWith("-"));
    if (!real) return null;
    const rb = base(real);
    if (!SHEBANG_BASH_INTERPRETERS.has(rb)) return { interp: `env ${rb}` };
  }
  return null;
}

/**
 * 分级明细（本轮主入口）。旧字符串版 `staticCheckIssues` 原样保留，既有调用与测试不动。
 * 2026-10-23 接线改造（用户批准）：
 *   bash（含 arbitrate_run）⇒ 语法判据交给 shellcheck（`-s bash -S <severity>`）。
 *     shellcheck 就绪 ⇒ **不再跑 `bash -n`**（同一问题不在两处报）；
 *     shellcheck 未就绪 ⇒ 显式降级（shellcheck-missing W，写进拒绝文案）并回退跑 `bash -n` 出 E。
 *   pwsh ⇒ 走 pwshParser 探测：不可用 ⇒ pwsh-no-parser W（「未参与检查」，不是通过）；
 *     可用 ⇒ tree-sitter 解析，ERROR/MISSING 节点 ⇒ E。command-missing 的 E 仍只给 bash
 *     （PowerShell cmdlet 天然不在本机 PATH 里，这条不变）。
 *   command-missing（严格 E 形状那套）与 path-missing **原样保留**，与 shellcheck 结果合并；
 *     语法 E 折叠成一条，SC 码进台账 `codes:[...]`，被 exclude 剔除的码进 `excluded:[...]`。
 * 可选入参：`cfg`（读 shellcheck 系四项与 pwshParser，缺省走 DEFAULTS）；
 *   `out`（把 { excluded, notices, shellcheckAvailable, pwshParserAvailable } 带回去给台账与
 *   拒绝文案用——避免为拿 excluded 再 spawn 一次 shellcheck）。
 */
export function staticIssuesDetailed({ script = "", shell = "bash", cfg = {}, out = null } = {}) {
  const sh = String(shell || "bash").toLowerCase() === "pwsh" ? "pwsh" : "bash";
  if (!String(script || "").trim()) return [];
  const c = cfg && typeof cfg === "object" ? cfg : {};
  const tail = ({ nonShellLang = false } = {}) => [
    ...staticCommandIssuesDetailed({ script, shell: sh, nonShellLang }),
    ...staticPathIssues(script),
  ];
  if (out && typeof out === "object") out.notices = out.notices || [];
  if (sh === "bash") {
    const bashW = [];   // bash 分支的「非通过」说明，与 command-missing / path-missing 平铺合并（W 不吞 E）
    const skip = nonBashShebang(script);
    if (skip) {
      // 缺口1（实测）：python / node / pwsh 脚本喂 `shellcheck -s bash` 出的是噪声 E（SC1036/1088/1065 那批），
      // 拦下来是把「解释器不匹配」报成「脚本语法错」。⇒ 跳过 shellcheck，记 W 进台账与 notices。
      const message = `shebang 指向 ${skip.interp}，shellcheck 不适用，已跳过（非通过）`;
      bashW.push({ rule: "non-bash-shebang", tier: "W", message, text: `语法判据未判：${message}` });
      if (out && typeof out === "object") {
        out.excluded = [];
        out.shellcheckAvailable = false;
        out.skippedShebang = skip.interp;
        out.notices.push(`非 bash 脚本（shebang=${skip.interp}）已跳过 shellcheck：bash 语法判据本轮未参与检查（非通过）`);
      }
      // 实测缺口（2026-10-23 主会话复验）：跳过 shellcheck 之后，`command-missing` 仍按 bash argv0 语义判 ⇒
      // 一段 python 正文（`import sys` / `def f` / `print(x)`）出 3 条 E（def / print / f「PATH 里查不到」）。
      // 非 bash 脚本的行首词不是要执行的命令 ⇒ 这条判据在这里没有语义基础，整条降 W（只记台账）。
      return [...bashW, ...tail({ nonShellLang: true })];   // path-missing E 保留（绝对路径判据与语言无关）
    }
    const sc = shellcheckScan({
      script, shellcheckPath: c.shellcheckPath, shellcheckSeverity: c.shellcheckSeverity,
      shellcheckExclude: c.shellcheckExclude, shellcheckTimeoutMs: c.shellcheckTimeoutMs,
    });
    const sev = SHELLCHECK_SEVERITIES.has(String(c.shellcheckSeverity || "").toLowerCase())
      ? String(c.shellcheckSeverity).toLowerCase() : DEFAULTS.shellcheckSeverity;
    if (out && typeof out === "object") {
      out.excluded = [...(sc.excluded || [])];
      out.shellcheckAvailable = sc.available;
      if (!sc.available) out.notices.push(SHELLCHECK_MISSING_NOTICE);
    }
    const es = sc.issues.filter((i) => i.tier === "E");
    const ws = [...sc.issues.filter((i) => i.tier !== "E"), ...bashW];
    if (!sc.available) {
      // 显式降级（不许静默）：语法判据失明 ⇒ 回退 bash -n；出 E 照旧拦得住。
      // 回退条只顶替语法判据本身（shellcheck-missing W 留在台账），command-missing / path-missing 不再被吞掉
      // ——2026-10-23 缺口修复：原来「语法先命中 ⇒ 不叠后两项」在判据失明时等于连自研两条一起关掉。
      const syn = syntaxIssue(script);
      if (syn) return [{ rule: "syntax", tier: "E", codes: [], text: syn }, ...sc.issues, ...staticPathIssues(script)];
      return [...sc.issues, ...tail()];
    }
    if (es.length) return [syntaxAggregate(es, `shellcheck -s bash -S ${sev}`), ...ws];   // 语法先命中 ⇒ 不叠后两项
    return [...ws, ...tail()];
  }
  const ps = pwshSyntaxIssues({ script, pwshParser: c.pwshParser });
  if (out && typeof out === "object") {
    out.pwshParserAvailable = ps.available;
    if (!ps.available) out.notices.push(PWSH_NO_PARSER_NOTICE);
  }
  const pe = ps.issues.filter((i) => i.tier === "E");
  const pw = ps.issues.filter((i) => i.tier !== "E");
  if (pe.length) return [syntaxAggregate(pe, "tree-sitter-powershell"), ...pw];
  return [...pw, ...tail()];
}

/** 行内豁免解析：`# guard: allow <rule> <原因>`。原因 <3 字符 ⇒ 无效（防"习惯性写一句注释"） */
export function parseStaticExemptions(script = "") {
  const out = [];
  for (const line of String(script || "").split("\n")) {
    const m = GUARD_ALLOW_RE.exec(line);
    if (!m) continue;
    const rule = m[1];
    const reason = String(m[2] || "").trim();
    const known = STATIC_RULES.has(rule);
    out.push({ rule, reason, known, valid: known && reason.length >= 3 });
  }
  return out;
}

/** 纯函数：把豁免套到命中上 ⇒ 可拦 E / 只记档 W / 被豁免 / 无效豁免。豁免只关 rule，不产生新语义 */
export function applyStaticExemptions({ issues = [], exemptions = [] } = {}) {
  const valid = new Set(exemptions.filter((e) => e.valid).map((e) => e.rule));
  const invalid = new Set(exemptions.filter((e) => !e.valid && e.known).map((e) => e.rule));
  const eBlocking = [], w = [], exempted = [], invalidExempt = [];
  for (const it of issues) {
    if (it.tier !== "E") { w.push(it); continue; }
    if (valid.has(it.rule)) { exempted.push(it); continue; }
    eBlocking.push(it);
    if (invalid.has(it.rule) && !invalidExempt.includes(it.rule)) invalidExempt.push(it.rule);
  }
  return { eBlocking, w, exempted, invalidExempt };
}

/**
 * 灰度自动收紧（2026-10-22 用户批准"先 log 一周"）：
 * mode=="log" 且 今天 > staticCheckLogUntil ⇒ 按 deny 处置（到期自动收紧，可审计）。
 * staticCheckLogUntil 写成非 ISO 日期 ⇒ 不自动收紧（宁可继续灰度，不可把生产锁死）。
 */
export function staticEffectiveMode(mode = "log", logUntil = "") {
  const m = String(mode || "off").toLowerCase();
  if (m !== "log") return m;
  const until = String(logUntil || "").trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(until)) return "log";
  return new Date().toISOString().slice(0, 10) > until ? "deny" : "log";
}

/**
 * 静态检查命中台账（2026-10-22 用户令：灰度/拦截都要留底，否则事后想改都没数据）。
 * 一行一个 JSON，字段固定，方便用 jq / awk 统计误报。路径固定，不随会话变。
 */
export function staticLogPath() {
  // 测试可用 GUARD_STATIC_LOG 指到临时文件，避免污染真台账
  return process.env.GUARD_STATIC_LOG || join(homedir(), ".dsh", "static-check.jsonl");
}

/**
 * 命中台账一行。旧字段（at/mode/tool/decision/issues/cmd）一律不动——历史行还要能对上；
 * 2026-10-22 分级版只往新行加字段：tier / rule / rules / shell / verdict / exempt / exemptInvalid。
 * 2026-10-23 shellcheck 版再加三个字段（同样只加不改）：
 *   codes    ⇒ 本轮命中的判据码（shellcheck 的 SC 码、tree-sitter 的 TS-* 码），逐条可统计；
 *   excluded ⇒ 被 shellcheckExclude 剔除掉的码（剔除必须留痕，否则事后查不到"为什么没报"）；
 *   notices  ⇒ 显式降级文案（shellcheck 失明 / pwsh 无解析器）——台账里没有这行就等于"静默全 W"。
 * verdict 固定 "unreviewed"：误报与否由 bin/static-verdict.sh 追加 verdict 行来标，不改原行。
 */
export function recordStaticHit({ tool = "", mode = "", cmd = "", issues = [], shell = "", tier = "",
  rules = [], exempt = null, exemptInvalid = null, decision = "",
  codes = null, excluded = null, notices = null } = {}) {
  const p = staticLogPath();
  try { mkdirSync(dirname(p), { recursive: true }); } catch { /* 目录已在 */ }
  const list = (issues || []).slice(0, 6);
  const codeOf = (i) => (i && Array.isArray(i.codes) ? i.codes : (i && i.code != null ? [i.code] : []));
  const codeList = (codes && codes.length ? codes : [...new Set((issues || []).flatMap(codeOf))]).filter(Boolean).slice(0, 12);
  const row = {
    at: new Date().toISOString(),
    mode,
    tool,
    decision: decision || (mode === "deny" ? "deny" : "log"),   // W 档没拦 ⇒ 记 log（2026-10-22：否则台账里 decision=deny 骗人）
    issues: list.map((s) => String(s && s.text || s).slice(0, 220)),
    cmd: redact(String(cmd || "")).slice(0, 400),
    tier: tier || (list.some((i) => i && i.tier === "E") ? "E" : "W"),
    rule: list[0] && list[0].rule || "",
    rules: (rules && rules.length ? rules : [...new Set(list.map((i) => i && i.rule).filter(Boolean))]),
    shell: shell || "bash",
    codes: codeList,
    verdict: "unreviewed",
  };
  if (excluded && excluded.length) row.excluded = [...new Set(excluded)].slice(0, 12);
  if (notices && notices.length) row.notices = [...new Set(notices.map((s) => redact(String(s)).slice(0, 200)))];
  if (exempt && exempt.length) row.exempt = exempt;
  if (exemptInvalid && exemptInvalid.length) row.exemptInvalid = exemptInvalid;
  try { appendFileSync(p, JSON.stringify(row) + "\n", { mode: 0o600 }); } catch { /* 写不进去也不能影响放行/拦截 */ }
  return row;
}

/** 豁免本身也要能统计（"我豁免了多少次"）⇒ 每次生效的豁免单独记一行 kind:"exempt" */
export function recordStaticExempt({ tool = "", shell = "", rule = "", reason = "" } = {}) {
  const p = staticLogPath();
  try { mkdirSync(dirname(p), { recursive: true }); } catch { /* 目录已在 */ }
  const row = {
    kind: "exempt",
    at: new Date().toISOString(),
    tool, shell: shell || "bash", rule,
    reason: redact(String(reason || "")).slice(0, 200),
  };
  try { appendFileSync(p, JSON.stringify(row) + "\n", { mode: 0o600 }); } catch { /* 台账写不进不影响放行 */ }
  return row;
}

/** 缺口4（2026-10-23）：显式降级文案的统一出口。
 *  deny ⇒ 「显式降级（不是「已检查通过」）」拼进拒绝文案（与改造前逐字一致，既有断言不受影响）；
 *  log  ⇒ 「显式降级（未拦截，仅告知）」——mode=log 是用户批准的灰度档，E 命中只记台账不拦，
 *          所以这段只能**告知**，绝不能变成拦截（见 apply 里 post-execute 那段机理注释）。
 *  没有 notices ⇒ 空串（不产生多余文案）。 */
export function staticNoticeText(mode = "log", notices = []) {
  const list = [...new Set((notices || []).map((s) => String(s)).filter(Boolean))];
  if (!list.length) return "";
  const head = String(mode || "").toLowerCase() === "deny"
    ? "**显式降级（不是「已检查通过」）**"
    : "显式降级（未拦截，仅告知）——本轮判据没跑完的部分";
  return `${head}：\n- ${list.join("\n- ")}`;
}

export function apply(ctx, config = {}) {
  const cfg = { ...DEFAULTS, ...config };
  const logFile = expand(cfg.logFile);
  const services = cfg.hostServices.map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  const allow = cfg.allowPatterns.map((p) => new RegExp(p));
  const disposeAllow = (cfg.disposeAllow || []).map(expand);
  const enabled = cfg.enabled !== false;
  // 缺口4（2026-10-23）：notices「让模型看见」的暂存表。key = exec 对象本身 ⇒ 天然按调用隔离
  // （同一条调用的 guard 与 tools/post-execute 拿到的是同一个 exec 实例，实测 dsh-tools/lib/index.js
  //   的 prepare → guardReason → dispatch → postExecute 全程传同一对象），WeakMap 随调用回收，
  //  且它在 apply() 里 ⇒ 每次 apply 一份，不是模块级单例，也不跨 agent。
  const noticePending = new WeakMap();
  // 软提示计数器（进程内，随会话生命周期）
  const nudgeDeleg = Number(cfg.nudgeDelegationAfter) || 0;
  const nudgeTodo = Number(cfg.nudgeTodoAfterBash) || 0;
  // 2026-10-22 修「串会话」：这组计数器原来是**进程级单例** ⇒ A 会话更新卡片会把 B 会话的
  // 「改盘 N 次 / N 分钟没更新」清零，B 的闸门永远不响（或反过来乱拦 A）。改成按 agentId 分片。
  const guardStates = new Map();   // agentId → { sinceDelegate, readSinceDelegate, bashSinceTodo, lastTodoAt, todoFingerprint, mutSinceTodo, todoBlocks }
  // 本会话的「计划文件路径」：由它自己第一次写 plan 文件时登记，不靠任何人猜 slug（按会话隔离）
  const planPathByAgent = new Map();
  const guardStateFor = (id) => {
    let s = guardStates.get(id);
    if (!s) {
      s = { sinceDelegate: 0, readSinceDelegate: 0, bashSinceTodo: 0,
            lastTodoAt: Date.now(), todoFingerprint: "", mutSinceTodo: 0, todoBlocks: 0 };
      if (guardStates.size > 64) {                 // 无界增长防护：满了先丢最早的一半
        let n = 0;
        for (const k of guardStates.keys()) { if (n++ >= 32) break; guardStates.delete(k); }
      }
      guardStates.set(id, s);
    }
    return s;
  };
  /** 会话身份：工具调用与 pre-step 两条路径都取它，取不到时才退到 "default" */
  const agentIdOf = (exec, payload) => String(
    exec?.agent?.id ?? exec?.agent?.sessionId ?? exec?.agentId
    ?? payload?.agent?.id ?? payload?.agent?.sessionId ?? "default");
  const writeHistory = new Map();   // `${agentId}\0${target}` → [{target, hash}]
  const cmdCounts = new Map();   // `${agentId}\0${fingerprint}` → {count, at}（按 id 而非对象，防对象重建后丢失）
  const gotchaPath = expand(cfg.gotchaIndex);
  const repeatExemptRe = cfg.repeatExempt ? new RegExp(cfg.repeatExempt.trim().replace(/\s+$/, ""), "i") : null;
  let gotchaRowsCache = { at: 0, rows: [] };
  const gotchaRows = () => {
    if (Date.now() - gotchaRowsCache.at < 60000) return gotchaRowsCache.rows;
    try { gotchaRowsCache = { at: Date.now(), rows: parseGotchaIndex(readFileSync(gotchaPath, "utf8")) }; }
    catch { gotchaRowsCache = { at: Date.now(), rows: [] }; }
    return gotchaRowsCache.rows;
  };   // 连续被拦次数：≥2 ⇒ fail-open，绝不让会话卡死
  try {
    ctx?.on?.("agent/pre-step", async (payload, next) => {
      const t = latestUserText(payload?.messages);
      if (t) {
        // 逐会话记录：别的会话说了「重启」不能给本会话授权
        noteUserText(payload?.agent, t);
      }
      return next();
    });
  } catch { /* 拿不到事件就退化成「无授权」 */ }
  const READS = Number(cfg.nudgeDelegationAfterReads) || 0;
  const TODO_MIN = Number(cfg.nudgeTodoAfterMinutes) || 0;
  // 只认"读放大"型命令：它们才真的会往上下文灌体积
  const READ_CMD = /(^|[\s;&|(])(cat|head|tail|less|more|grep|rg|find|journalctl|dmesg|curl|wget|sshpass|scp|ssh|openfiles|systemctl\s+(status|show)|ps|ls\s+-[a-zA-Z]*R|tree)\b/;
  const DELEGATE_HINT =
    "连续 %N% 条读类命令没有派过子代理。R-15 的判据是「会往主上下文灌进多少」：" +
    "工具结果 >200 KB / 单次 bash 输出 >5 万字节 / 同一目标 ≥3 条互不依赖的探针 ⇒ 必须派。" +
    "派活照 templates/delegate.md 三段填（范围 / 判据 / 输出 schema）。" +
    "本条是软提示：计数已重置，下一次放行——但请先用 subagent 或 subagent_fork 把读入量挪出去。";
  const TODO_HINT =
    "连续 %N% 次 shell 调用没有更新任务卡片。长回合里卡片会停在开局版本" +
    "（实测 42 分钟会话只更新过 1 次）。先 todo_write 再说：把当前进度与下一步写进去。" +
    "本条是软提示：计数已重置，下一次放行。";
  const slot = expand(cfg.snapshotSlot);
  const autoSnap = cfg.autoSnapshot === true;
  const maxAutoSnapBytes = Number(cfg.maxAutoSnapshotBytes) || 8388608;
  const targets_prefix = cfg.snapshotTargets.map(expand);
  const exempt_prefix = cfg.snapshotExempt.map(expand);

  try { mkdir(logFile.replace(/\/[^/]*$/, ""), { recursive: true }); } catch { /* 目录已存在 */ }
  try { chmodSync(logFile, 0o600); } catch { /* 文件还不存在就等第一次写 */ }

  const log = (line) => {
    appendFile(logFile, `${new Date().toISOString()} ${line}\n`, () => {}); // 异步 fire-and-forget
  };

  // 软提示：计数器维护 + 命中阈值时返回提示语（deny-once-then-reset）
  // 2026-10-22：按会话分片（原为进程级单例，跨会话互相清零）
  const bump = (toolName, cmdText = "", agentId = "default") => {
    const st = guardStateFor(agentId);
    if (nudgeDeleg > 0) {
      if (toolName === "subagent" || toolName === "subagent_fork") st.sinceDelegate = 0;
      else {
        st.sinceDelegate += 1;
        if (st.sinceDelegate >= nudgeDeleg) { st.sinceDelegate = 0; return DELEGATE_HINT.replace("%N%", nudgeDeleg); }
      }
    }
    if (READS > 0) {
      if (toolName === "subagent" || toolName === "subagent_fork") st.readSinceDelegate = 0;
      else if (READ_CMD.test(String(cmdText))) {
        st.readSinceDelegate += 1;
        if (st.readSinceDelegate >= READS) { st.readSinceDelegate = 0; return DELEGATE_HINT.replace("%N%", READS); }
      }
    }
    if (TODO_MIN > 0) {
      if (toolName === "todo_write") st.lastTodoAt = Date.now();
      else if (Date.now() - st.lastTodoAt >= TODO_MIN * 60000) { st.lastTodoAt = Date.now(); return TODO_HINT.replace("%N%", TODO_MIN); }
    }
    if (nudgeTodo > 0) {
      if (toolName === "todo_write") st.bashSinceTodo = 0;
      else if (toolName === "bash" || toolName === "pwsh") {
        st.bashSinceTodo += 1;
        if (st.bashSinceTodo >= nudgeTodo) { st.bashSinceTodo = 0; return TODO_HINT.replace("%N%", nudgeTodo); }
      }
    }
    return undefined;
  };

  const check = (exec) => {
    if (!enabled) return undefined;
    const name = exec?.name;
    const aid = agentIdOf(exec);      // 本会话身份：卡片闸 / 计数 / 计划文件都按它分片
    // ── 后台子代理：本机单序列 ⇒ 必须前台等 ─────────────────────────────
    if (cfg.denyBackgroundSubagent !== false && (name === "subagent" || name === "subagent_fork")) {
      let a = exec?.arguments ?? {};
      if (typeof a === "string") { try { a = JSON.parse(a); } catch { a = {}; } }
      if (a.run_in_background !== false) {
        return "后台子代理在本机不成立：本机是单序列引擎，一次只跑一条（serve/server.py:7，在役命令行无 --batch），" +
          "子代理在后台跑时主对话每发一步都要和它抢同一条序列、双方互相逐出前缀。" +
          "实测：子代理跑的那 4 分钟里父会话又发了 3 步。改 `run_in_background: false` 前台等它回来——" +
          "子代理的收益是省主上下文，不是省时间（R-15）。";
      }
    }

    const isShell = name === "bash" || name === "pwsh";
    const isArb = name === "arbitrate_run";
    const isFileWrite = name === "write" || name === "edit";

    // 快照闸门（§12）：写入宿主消费集 ⇒ 必须有单槽快照
    if (cfg.requireSnapshot !== false && (isShell || isFileWrite)) {
      const targets = isFileWrite
        ? [String(exec?.arguments?.file_path ?? "")].filter(Boolean).map(expand)
        : shellWriteTargets(String(exec?.arguments?.command ?? ""));
      const hits = targets
        .map((p) => ({ raw: p, abs: p.startsWith("/") ? p : "" }))
        .filter(({ abs }) => abs && under(abs, targets_prefix) && !under(abs, exempt_prefix));
      for (const { abs } of hits) {
        if (snapshotExists(slot, abs)) continue;
        if (autoSnap && tryAutoSnapshot(slot, abs, maxAutoSnapBytes)) {
          log(`AUTOSNAP target=${abs}`);
          continue;
        }
        return `宿主消费集内的写入没有快照，失败无法自动回退（规则 R-12）。先跑：snap.sh '${abs}'（单槽，仅留最新），再执行本次写入；还原用 restore.sh '${abs}'。豁免前缀：${cfg.snapshotExempt.join(" ")}`;
      }
    }

    // ── 跨机执行·编码闸：写 Windows 脚本含非 ASCII 且无 BOM ⇒ 拦 ────────────
    if (isFileWrite && cfg.denyNonAsciiPs1 !== false) {
      const a = exec?.arguments ?? {};
      const gEnc = ps1EncodingGate({
        path: String(a.file_path ?? a.path ?? ""),
        content: String(a.content ?? a.new_string ?? ""),
      });
      if (gEnc) return gEnc;
    }
    if (cfg.denyWritesWhilePlanDraft !== false) {
      // 2026-10-22 二次修：
      //   ① 旧实现让模型自己拼 slug（R-02 只写 <cwd slug> 没给算法）⇒ 实测被写成
      //      ~/.dsh/plans/Harnessworks/active.md，而守卫读的是 -home-loong-文档-Harnessworks ⇒
      //      两边对不上，计划门**静默失效**。
      //   ② cwd 常常是父目录（实测会话从 文档/Harnessworks 启动，任务在 openclaw66-… 子目录）⇒
      //      按 cwd 分桶也落不到任务目录。
      // 现在：**计划文件放哪由会话自己决定，守卫记住本会话写过的那份**；没写过才退回 cwd 桶。
      const planTarget = (name === "write" || name === "edit")
        ? String(exec?.arguments?.file_path ?? exec?.arguments?.path ?? "") : "";
      const isPlanWrite = planTarget !== "" && PLAN_FILE_RE.test(planTarget);
      if (isPlanWrite) {
        planPathByAgent.set(aid, planTarget);       // 记住：以后这个会话的 draft 状态就以它为准
      } else {
        const declared = planPathByAgent.get(aid);
        const cwd = String(exec?.agent?.session?.header?.cwd ?? process.cwd() ?? "");
        const pf = declared || String(cfg.planFile || "~/.dsh/plans/{cwd}/active.md").replace("{cwd}", cwdSlug(cwd));
        const abs = expand(pf);
        const gPlan = planGate({
          name, cmd: String(exec?.arguments?.command ?? exec?.arguments?.script ?? ""),
          plan: planState(abs), session: aid, scope: cwd,
        });
        if (gPlan) return gPlan;
      }
    }
    // ── 不可解析输入闸：本轮用户消息解析不出动作 ⇒ 本轮禁改盘（2026-10-22 用户裁决）──
    // 只判改盘类调用：write / edit ⇒ mutating；bash/pwsh 由 shellWriteTargets 看有没有写盘目标。
    // 只读调用（read / 无写盘目标的 shell）一律放行。
    // **计划文件本身照旧写得进去**：写计划 = 把方案落到盘上，不是执行方案；把它拦掉会造出
    // 「draft 永远写不进去」的死锁（先例 incidents/INC-2026-10-22-plan-gate-deadlock.md）⇒ 对 plan 目标跳过本闸。
    if (cfg.denyUnparsableWrites !== false) {
      const notPlanTarget = (p) => String(p || "") !== "" && !PLAN_FILE_RE.test(String(p));
      const isMutCall = isFileWrite
        ? notPlanTarget(exec?.arguments?.file_path ?? exec?.arguments?.path ?? "")
        : (isShell && shellWriteTargets(String(exec?.arguments?.command ?? exec?.arguments?.script ?? ""))
            .some((p) => !PLAN_FILE_RE.test(String(p))));
      const gUnparsable = unparsableGate({
        userText: userTextOf(exec?.agent),
        mutating: isMutCall,
        enabled: cfg.denyUnparsableWrites !== false,
      });
      if (gUnparsable) return gUnparsable;
    }
    // ── 卡片硬门：改盘 N 次 / M 分钟没有「有效」更新 ⇒ 拒下一次改盘 ──────────
    {
      const everyMut = Number(cfg.requireTodoEveryMutations) || 0;
      const everyMin = Number(cfg.requireTodoEveryMinutes) || 0;
      const isMut = name === "write" || name === "edit" || name === "arbitrate_run"
        || (name === "bash" && STATE_CHANGING.test(String(exec?.arguments?.command ?? "")));
      const S = guardStateFor(aid);           // 2026-10-22：卡片状态按会话分片，不再跨会话互相清零
      if (name === "todo_write") {
        const items = exec?.arguments?.todos ?? exec?.arguments?.items ?? [];
        const fp = JSON.stringify(items);
        if (fp === S.todoFingerprint) {
          return "这次 todo_write 的内容与上次**完全相同**，不算更新。卡片是进度快照，不是收尾报告："
            + "把已完成的标 completed、把当前正在做的写清楚、补上下一条，再提交。";
        }
        S.todoFingerprint = fp;
        S.mutSinceTodo = 0;
        S.todoBlocks = 0;
        S.lastTodoAt = Date.now();
      } else if (isMut) {
        const mins = (Date.now() - S.lastTodoAt) / 60000;
        const overMut = everyMut > 0 && S.mutSinceTodo >= everyMut;
        const overMin = everyMin > 0 && mins >= everyMin && S.mutSinceTodo >= 2;
        if (overMut || overMin) {
          S.todoBlocks += 1;
          if (S.todoBlocks >= 2) {
            // fail-open：拦不住就放行，绝不让会话卡在「改盘被拒 ↔ 卡片写不对」之间
            S.mutSinceTodo = 0;
            S.todoBlocks = 0;
            return undefined;
          }
          return `任务卡片过期（已连续 ${S.mutSinceTodo} 次改盘 / ${Math.round(mins)} 分钟没更新）⇒ 先 todo_write 再继续。`
            + "卡片是进度快照，不是收尾报告；**同内容重写不算更新**。最小合法样例：\n"
            + '  todos: [{"content":"B1 索引纠偏","status":"completed"},'
            + '{"content":"B2 快照归位","status":"in_progress"},{"content":"B3 README 死声明","status":"pending"}]\n'
            + "（实测：50 次改盘只更新过 1 次卡片，且那次还发生在 5 次改盘之后。）";
        }
        S.mutSinceTodo += 1;
      }
    }
    // ── FM-1.5 停滞闸：同一文件连续写出相同内容 ⇒ 空转 ──────────────────────
    {
      const isWrite = name === "write" || name === "edit";
      if (isWrite && Number(cfg.stallAt) > 0) {
        const a = exec?.arguments ?? {};
        const target = String(a.file_path ?? a.path ?? "");
        const content = String(a.content ?? a.new_string ?? "");
        if (target) {
          const agentId = String(exec?.agent?.id ?? exec?.agent?.sessionId ?? exec?.agentId ?? "default");
          const key = agentId + "\0" + target;
          const hist = writeHistory.get(key) || [];
          const gStall = stallGate({ target, content, history: hist, at: Number(cfg.stallAt) });
          hist.push({ target, hash: contentHash(content) });
          writeHistory.set(key, hist.slice(-8));
          if (gStall) return gStall;
        }
      }
    }
    // ── L3 版经验库触发器：同一命令形状重复 ⇒ 拦 + 附命中的经验库行 ──────────
    {
      const isCmd = name === "bash" || name === "pwsh" || name === "arbitrate_run";
      const cmdText = String(exec?.arguments?.command ?? exec?.arguments?.script ?? "");
      const exempt = repeatExemptRe ? repeatExemptRe.test(cmdText) : false;
      if (isCmd && cmdText && !exempt && Number(cfg.repeatDenyAt) > 0) {
        const agentId = String(exec?.agent?.id ?? exec?.agent?.sessionId ?? exec?.agentId ?? "default");
        const fp = commandFingerprint(cmdText);
        const key = agentId + "\0" + fp;
        const win = Number(cfg.repeatWindowMinutes) * 60000;
        const prev = cmdCounts.get(key);
        const count = prev && Date.now() - prev.at < win ? prev.count + 1 : 1;
        if (cmdCounts.size > 500) { for (const [k, v] of cmdCounts) if (Date.now() - v.at > win) cmdCounts.delete(k); }
        cmdCounts.set(key, { count, at: Date.now() });
        if (process.env.GOTCHA_DEBUG) console.error('[gotcha]', { fp: fp.slice(0,40), count, exempt, at: cfg.repeatDenyAt });
        const g = repeatGate({ cmd: cmdText, count, at: Number(cfg.repeatDenyAt), rows: gotchaRows() });
        if (g) {
          cmdCounts.set(key, { count: 0, at: Date.now() });   // 拦过即清零，避免永久锁死
          return g;
        }
      }
    }
    if (name === "ask_user_question" && cfg.denyAskWhileAnalyzing !== false) {
      const a = exec?.arguments && typeof exec.arguments === "object" ? exec.arguments : {};
      const qs = Array.isArray(a.questions) ? a.questions : [];
      const qText = qs.map((x) => `${(x && x.header) || ""} ${(x && x.question) || ""}`).join(" ");  // header 也参与判据：可逆性标在 header
      const oText = qs.map((x) => (Array.isArray(x && x.options) ? x.options.map((o) => String((o && o.label) || "")).join(" ") : "")).join(" ");
      const gAsk = askGate({ userText: userTextOf(exec?.agent), question: qText, options: oText });
      if (gAsk) return gAsk;
    }
    if (!isShell && !isArb) { bump(name, "", aid); return undefined; } // 窄面（判据 2）：非 shell 只维护计数

    const cmd = isShell ? exec?.arguments?.command : exec?.arguments?.script;
    if (typeof cmd !== "string" || !cmd) return undefined;
    if (allow.some((re) => re.test(cmd))) return undefined; // 逃生口

    // ── 生成物静态检查（分级放行版）：E 档才按 mode 处置，W 档只落台账 ──────────
    // 开关：staticCheckMode = off | log | deny；staticCheckLogUntil = 灰度到期日（log 到期自动按 deny）。
    // 失效症状（写进 README）：改了不生效 ⇒ 先看是不是 mode 被 effectiveMode 抬成 deny（今天 > 到期日）；
    // 台账没新行 ⇒ staticCheckMode 被显式设成 off，或命中全被行内豁免掉了（台账里有 kind:"exempt" 行）。
    // 2026-10-23：bash 语法判据交给 shellcheck；未就绪/超时 ⇒ 显式降级（notices 进拒绝文案 + 台账），
    // pwsh 无解析器同理 ⇒ 「未参与检查（非通过）」，绝不静默算通过。
    {
      const mode0 = String(cfg.staticCheckMode || "off").toLowerCase();
      if (mode0 !== "off") {
        const shell = name === "pwsh" ? "pwsh" : "bash";
        const mode = staticEffectiveMode(mode0, cfg.staticCheckLogUntil);
        const out = { notices: [], excluded: [], shellcheckAvailable: true, pwshParserAvailable: false };
        const found = staticIssuesDetailed({ script: cmd, shell, cfg, out });
        const exemptions = parseStaticExemptions(cmd);
        const { eBlocking, w, exempted, invalidExempt } = applyStaticExemptions({ issues: found, exemptions });
        for (const e of exemptions) if (e.valid) recordStaticExempt({ tool: name, shell, rule: e.rule, reason: e.reason });
        const hit = [...eBlocking, ...w];
        const notices = [...new Set(out.notices || [])];
        const codes = [...new Set(found.flatMap((i) => (Array.isArray(i.codes) ? i.codes
          : (i && i.code != null ? [i.code] : []))))].filter(Boolean);
        const excluded = [...new Set(out.excluded || [])];
        // 只有剔除、没有命中也要落一行：剔除不留痕 ⇒ 事后查不到「为什么没报」
        if (hit.length > 0 || excluded.length > 0) {
          const row = recordStaticHit({
            tool: name, mode, cmd, shell, issues: hit,
            decision: mode === "deny" && eBlocking.length > 0 ? "deny" : "log",
            tier: eBlocking.length ? "E" : "W",
            rules: [...new Set(hit.map((h) => h.rule))],
            exempt: exempted.map((h) => h.rule),
            exemptInvalid: invalidExempt,
            codes, excluded, notices,
          });
          log(`STATIC tool=${name} mode=${mode0}>${mode} tier=${row.tier} E=${eBlocking.length} W=${w.length} exempt=${exempted.length} rules=${row.rules.join(",")} codes=${codes.join(",")} excluded=${excluded.join(",")} notices=${notices.length} first=${String((hit[0] && hit[0].text) || "excluded-only").slice(0, 90)}`);
          // 缺口4（2026-10-23）：mode=log 是用户批准的灰度档 ⇒ 处置段不返回文本 ⇒ notices 原来只有台账看得见。
          // 这里把「本轮哪些判据没跑完」交给 post-execute 的 accept 通道：只告知，不改拦/放（判据仍是 E 命中）。
          if (mode !== "deny" && notices.length) {
            noticePending.set(exec, staticNoticeText("log", notices)
              + `\n（本轮命中只记台账、未拦截：${staticLogPath()}${eBlocking.length ? `；E 档 ${eBlocking.length} 条，mode=log 到期 ${cfg.staticCheckLogUntil} 自动转 deny` : ""}）`);
          }
          if (mode === "deny" && eBlocking.length > 0) {
            const body = `静态检查命中（**还没执行**，本次已拦）——这条是**可拦档（E）**：\n- `
              + eBlocking.slice(0, 4).map((h) => h.text).join("\n- ")
              + (w.length ? `\n提示（W 档·不拦，只记台账给你自己看见）：\n- ` + w.slice(0, 4).map((h) => h.text).join("\n- ") : "")
              // 显式降级必须让模型看见：写在拒绝文案里，不是只进台账
              + (notices.length ? `\n**显式降级（不是「已检查通过」）**：\n- ` + notices.join("\n- ") : "")
              + (excluded.length ? `\n本轮被 shellcheckExclude 剔除的码：${excluded.join(" ")}（台账 excluded 留痕）` : "")
              + (invalidExempt.length ? `\n豁免无效（缺原因）：\`# guard: allow ${invalidExempt.join(" / ")} <原因>\` 必须写出原因（≥3 字），否则命中照常拦。` : "")
              + `\n（命中已记进 ${staticLogPath()}，tier=${row.tier} codes=${codes.join(" ") || "-"} verdict=unreviewed；判为误报用 bin/static-verdict.sh <行号> fp "备注" 标出来，事后按台账收窄规则）`
              + (w.length ? "\n（W 档不拦：函数名 / case 通配 / 变量展开 / 引号载荷 / 子 shell 内部 / heredoc 正文，以及 shellcheck 的 warning/info/style 档都属 W）" : "");
            return body + "\n先修再提交：bash 语法用 `~/.local/bin/shellcheck -s bash -S error <脚本>` 自查（本机判据就是它）；路径/命令拼错先 `ls` / `command -v` 一眼——这些都是不用跑就能定的错。确属有意为之 ⇒ 在脚本里加一行 `# guard: allow <rule> <原因>` 豁免（会落台账）。";
          }
        }
      }
    }

    // ── 跨机执行·联动闸：搬运 + 注册/启动 串在 && ⇒ 拦（整条命令级判据） ──────
    if (cfg.denyChainedRegistration !== false) {
      const gChain = chainedRemoteGate({ cmd });
      if (gChain) return gChain;
    }
    if (cfg.denyNonAsciiPs1 !== false) {
      const gEnc = ps1EncodingGate({ cmd });
      if (gEnc) return gEnc;
    }
    // ── 凭据来源闸：明文凭据 / 从文件翻密钥 ⇒ 拦，指到 vault（2026-10-22） ──────
    if (cfg.denyInlineCredentials !== false) {
      const gCred = inlineCredentialGate({ cmd });
      if (gCred) return gCred;
    }
    if (cfg.denySecretFileRead !== false) {
      const gFile = secretFileGate({ cmd });
      if (gFile) return gFile;
    }

    const segs = segments(cmd);

    // 整条命令级判据先跑（跨管道/跨换行的形态，拆段后看不到）
    const whole = wholeCommand(cmd);
    if (whole) return whole;

    if (isShell) {
      const g1 = restartGate({ cmd, userText: userTextOf(exec?.agent), enabled: cfg.requireUserAuthForRestart !== false });
      if (g1) return g1;
      const g2 = parallelGate({ cmd, window: liveWindow(), enabled: cfg.denyParallelHeavy !== false });
      if (g2) return g2;
    }
    if (cfg.denyRestartInScript !== false && isArb && services.some((s) => new RegExp(`\\brestart\\b[^\\n]*${s}`).test(cmd))) {
      return "arbitrate_run 的脚本里含宿主重启：脚本会随会话载体被回收，marker 永远读不到。把重启拆成独立调用（③ 之后单独重启），脚本里不要重启宿主（R-12）。";
    }
    if (cfg.denyRestartWithBackground !== false && isShell) {
      const r = restartWithBackground(cmd, services);
      if (r) return r;
    }
    if (cfg.denyPkillF !== false) {
      for (const s of segs) { const r = selfMatch(s); if (r) return r; }
    }
    if (cfg.denyBypass !== false) {
      for (const s of segs) { const r = bypass(s); if (r) return r; }
    }
    if (cfg.denyDestructive !== false) {
      const vars = collectVars(cmd);
    for (const s of segs) { const r = destructive(s, disposeAllow, vars); if (r) return r; }
    }
    return bump(name, cmd, aid);
  };

  // guard 必须同步；自身出错一律 fail-open，绝不因防线故障锁死生产
  // 缺口4（2026-10-23）：log 档的 notices 送达模型，且**不改拦/放**。机理实测两条：
  //   ① ctx.tools.guard() 返回字符串 = 拒绝（dsh-tools/lib/index.js:2646 guardReason ⇒ 首个非 undefined
  //      直接 materializeFinalResult(isError:true)）⇒ 在 guard 里"把 notices 拼进返回文本"必然把
  //      mode=log 的"放"变成"拦"，与硬约束「不得因拼文本而改变拦/放判定」互斥。
  //   ② 非拦截通道确实存在：tools/post-execute 返回 {kind:"accept", additionalContexts:[UserMessage]}——
  //      dsh-tools/lib/index.js:3503 postExecute：accept 保留原结果（拦/放判定早已在 guard 定完），
  //      additionalContexts 被"ferried on the returned result for the loop's active-batch FIFO"带给模型
  //      （同型实现见 @deepseek-ai/dsh-repeat-tool-reminder 的 post-execute 监听）。
  //   ⇒ log 档的显式降级走这里（只告知），deny 档的显式降级继续拼在拒绝文案里（模型本来就看得到）。
  if (typeof ctx.on === "function") {
    ctx.on("tools/post-execute", async (exec, _result, next) => {
      const decision = await next();
      const text = noticePending.get(exec);
      if (!text) return decision;
      noticePending.delete(exec);
      const msg = {
        role: "user",
        content: [{ type: "text", text }],
        source: { kind: "tool-guard", form: "notice", summary: "静态检查显式降级（未拦截，仅告知）" },
      };
      const contexts = [msg, ...(decision.additionalContexts || [])];
      if (decision.kind === "block") return { kind: "block", feedback: decision.feedback, additionalContexts: contexts };
      return { ...decision, additionalContexts: contexts };
    });
  }
  // pwsh 装载预约（2026-10-23）：pwshParser=auto ⇒ 插件加载阶段就把装载发出去，宿主启动不等它
  //   （装载本身懒、有 2s 预算；第一次 pwsh 调用同步读缓存 ⇒ 未就绪就是显式降级 W）。
  if (String(cfg.pwshParser ?? DEFAULTS.pwshParser).toLowerCase() === "auto") ensurePwshParser("auto");
  const dispose = ctx.tools.guard((exec) => {
    try {
      const reason = check(exec);
      if (reason) log(redact(`DENY tool=${exec?.name} reason="${reason.slice(0, 90)}…" cmd=${String(exec?.arguments?.command ?? exec?.arguments?.script ?? "").slice(0, 160)}`));
      return reason;
    } catch (e) {
      log(`GUARD-ERROR tool=${exec?.name} err=${e?.message}`);
      return undefined;
    }
  });

  ctx.effect(() => dispose, "tool-guard: dispose monotonic guard");
  ctx.logger?.info?.(`tool-guard: guard registered (enabled=${enabled}, log=${logFile})`);
}

// 不要加 `export default apply`。
// cordis-plugin-loader 的 unwrapExports = `exports.default ?? exports`（lib/index.js:664-669）：
// 有 default 导出 ⇒ 命名空间被折叠成裸函数 ⇒ cordis 看不到 name / inject / Config，
// `inject: ["tools"]` 失效 ⇒ ctx.tools 不存在 ⇒ apply 抛错、插件被静默跳过（2026-10-15 实测踩过）。
