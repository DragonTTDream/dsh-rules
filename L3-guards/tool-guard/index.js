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
import { appendFile, chmodSync, copyFileSync, existsSync, mkdir, mkdirSync, readFileSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
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
  denyParallelHeavy: z.boolean(),
  denyAskWhileAnalyzing: z.boolean(),
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

const DEFAULTS = {
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
  // 本机单序列引擎：已有一个重活窗口在跑时，禁止再起 detached 重活（并行只会互相抢资源）。
  denyParallelHeavy: true,
  // 2026-10-22 用户令：他还在分析/看方案时，模型不许把方案收敛成选择题逼他拍板
  //（实测反例：用户正在权衡三条路，模型直接问「走哪条？」）
  denyAskWhileAnalyzing: true,
  // 2026-10-22（社区：Claude Code Plan Mode 的权限降级 / Cline Plan&Act / Spec Kit 分阶段）：
  // 方案文件存在且 status: draft ⇒ 禁一切改盘动作，只允许只读侦察与写方案。
  // 批准必须是用户给的：status: approved 且记录了逐字用户消息，未记录一律当 draft。
  planFile: "~/.dsh/plans/active.md",
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
  fallbackUserText = t;
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

/** 计划未定稿时该不该拦这次动作。纯函数。 */
export function planGate({ name = "", cmd = "", plan = { exists: false }, session = "", enabled = true } = {}) {
  if (!enabled) return undefined;
  if (!plan.exists || plan.approved) return undefined;
  // 2026-10-22 修：计划文件是全局单文件，之前会拿**别的会话**的 draft 拦住本会话（实测被拦一次，
  // 且造成"修这个缺陷的写操作也被同一缺陷拦住"的鸡生蛋死锁）。
  // 规则：计划声明了 session 且不是本会话 ⇒ 不归我管；没声明 session ⇒ 视为历史文件，不拦。
  if (!plan.session || plan.session !== session) return undefined;
  const isWriteTool = name === "write" || name === "edit";
  const isShellWrite = name === "bash" && STATE_CHANGING.test(String(cmd || ""));
  const isRun = name === "arbitrate_run";
  if (!isWriteTool && !isShellWrite && !isRun) return undefined;
  return "方案还没定稿（`~/.dsh/plans/active.md` 里 status: draft）⇒ **禁止改盘**，只做只读侦察与写方案。"
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

export function apply(ctx, config = {}) {
  const cfg = { ...DEFAULTS, ...config };
  const logFile = expand(cfg.logFile);
  const services = cfg.hostServices.map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  const allow = cfg.allowPatterns.map((p) => new RegExp(p));
  const disposeAllow = (cfg.disposeAllow || []).map(expand);
  const enabled = cfg.enabled !== false;
  // 软提示计数器（进程内，随会话生命周期）
  const nudgeDeleg = Number(cfg.nudgeDelegationAfter) || 0;
  const nudgeTodo = Number(cfg.nudgeTodoAfterBash) || 0;
  let sinceDelegate = 0;
  let readSinceDelegate = 0;
  let bashSinceTodo = 0;
  let lastTodoAt = Date.now();
  let todoFingerprint = "";
  let mutSinceTodo = 0;
  let todoBlocks = 0;
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
  const bump = (toolName, cmdText = "") => {
    if (nudgeDeleg > 0) {
      if (toolName === "subagent" || toolName === "subagent_fork") sinceDelegate = 0;
      else {
        sinceDelegate += 1;
        if (sinceDelegate >= nudgeDeleg) { sinceDelegate = 0; return DELEGATE_HINT.replace("%N%", nudgeDeleg); }
      }
    }
    if (READS > 0) {
      if (toolName === "subagent" || toolName === "subagent_fork") readSinceDelegate = 0;
      else if (READ_CMD.test(String(cmdText))) {
        readSinceDelegate += 1;
        if (readSinceDelegate >= READS) { readSinceDelegate = 0; return DELEGATE_HINT.replace("%N%", READS); }
      }
    }
    if (TODO_MIN > 0) {
      if (toolName === "todo_write") lastTodoAt = Date.now();
      else if (Date.now() - lastTodoAt >= TODO_MIN * 60000) { lastTodoAt = Date.now(); return TODO_HINT.replace("%N%", TODO_MIN); }
    }
    if (nudgeTodo > 0) {
      if (toolName === "todo_write") bashSinceTodo = 0;
      else if (toolName === "bash" || toolName === "pwsh") {
        bashSinceTodo += 1;
        if (bashSinceTodo >= nudgeTodo) { bashSinceTodo = 0; return TODO_HINT.replace("%N%", nudgeTodo); }
      }
    }
    return undefined;
  };

  const check = (exec) => {
    if (!enabled) return undefined;
    const name = exec?.name;
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

    if (cfg.denyWritesWhilePlanDraft !== false) {
      const pf = String(cfg.planFile || "~/.dsh/plans/active.md");
      const abs = pf.startsWith("~") ? `${process.env.HOME || "/home/loong"}${pf.slice(1)}` : pf;
      const sid = String(exec?.agent?.id ?? exec?.agent?.sessionId ?? exec?.agentId ?? "");
      const gPlan = planGate({
        name, cmd: String(exec?.arguments?.command ?? exec?.arguments?.script ?? ""),
        plan: planState(abs), session: sid,
      });
      if (gPlan) return gPlan;
    }
    // ── 卡片硬门：改盘 N 次 / M 分钟没有「有效」更新 ⇒ 拒下一次改盘 ──────────
    {
      const everyMut = Number(cfg.requireTodoEveryMutations) || 0;
      const everyMin = Number(cfg.requireTodoEveryMinutes) || 0;
      const isMut = name === "write" || name === "edit" || name === "arbitrate_run"
        || (name === "bash" && STATE_CHANGING.test(String(exec?.arguments?.command ?? "")));
      if (name === "todo_write") {
        const items = exec?.arguments?.todos ?? exec?.arguments?.items ?? [];
        const fp = JSON.stringify(items);
        if (fp === todoFingerprint) {
          return "这次 todo_write 的内容与上次**完全相同**，不算更新。卡片是进度快照，不是收尾报告："
            + "把已完成的标 completed、把当前正在做的写清楚、补上下一条，再提交。";
        }
        todoFingerprint = fp;
        mutSinceTodo = 0;
        todoBlocks = 0;
        lastTodoAt = Date.now();
      } else if (isMut) {
        const mins = (Date.now() - lastTodoAt) / 60000;
        const overMut = everyMut > 0 && mutSinceTodo >= everyMut;
        const overMin = everyMin > 0 && mins >= everyMin && mutSinceTodo >= 2;
        if (overMut || overMin) {
          todoBlocks += 1;
          if (todoBlocks >= 2) {
            // fail-open：拦不住就放行，绝不让会话卡在「改盘被拒 ↔ 卡片写不对」之间
            mutSinceTodo = 0;
            todoBlocks = 0;
            return undefined;
          }
          return `任务卡片过期（已连续 ${mutSinceTodo} 次改盘 / ${Math.round(mins)} 分钟没更新）⇒ 先 todo_write 再继续。`
            + "卡片是进度快照，不是收尾报告；**同内容重写不算更新**。最小合法样例：\n"
            + '  todos: [{"content":"B1 索引纠偏","status":"completed"},'
            + '{"content":"B2 快照归位","status":"in_progress"},{"content":"B3 README 死声明","status":"pending"}]\n'
            + "（实测：50 次改盘只更新过 1 次卡片，且那次还发生在 5 次改盘之后。）";
        }
        mutSinceTodo += 1;
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
    if (!isShell && !isArb) { bump(name, ""); return undefined; } // 窄面（判据 2）：非 shell 只维护计数

    const cmd = isShell ? exec?.arguments?.command : exec?.arguments?.script;
    if (typeof cmd !== "string" || !cmd) return undefined;
    if (allow.some((re) => re.test(cmd))) return undefined; // 逃生口

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
    return bump(name, cmd);
  };

  // guard 必须同步；自身出错一律 fail-open，绝不因防线故障锁死生产
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
