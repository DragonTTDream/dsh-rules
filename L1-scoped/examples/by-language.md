# 示例：按语言/技术栈挂规则（原生做法，零代码）

DSH 的 `dsh-agent-instructions` 在**模型碰到某个文件**时，会把 cwd 与那个文件之间
经过的目录里的 `AGENTS.md` 一并拉进来。所以"改 Go 就带 Go 规则"不需要插件，
只需要把规则文件放到**代码树那一层**。

## 目录放法

```
repo/
├── AGENTS.md              ← 全局：本仓的通用约定（L1）
├── engine/                ← Go 代码树
│   └── AGENTS.md          ← 只写 Go 相关（编译标签、错误处理、禁用的标准库用法）
└── ops/                   ← PowerShell 探针
    └── AGENTS.md          ← 只写 PS 相关（引号、$LASTEXITCODE、编码）
```

模型改 `engine/foo.go` ⇒ `engine/AGENTS.md` 自动生效；
改 `ops/probe.ps1` ⇒ 只有 `ops/AGENTS.md` 生效。两条规则互不污染上下文。

## 写什么（示例：Go）

```markdown
# engine/ — Go 代码约定

1. **本机无 vulkan/x11 头文件** ⇒ 构建必带 `-tags novulkan,nox11`，且在文档里写清。
2. **Windows 交叉编译后必须验 Subsystem**：`objdump -p <exe> | awk '/^Subsystem/{print $2}'`，
   期望 `2`（GUI）。`3`（控制台）会让双击弹黑框 —— 这是发布前最常见的漏检。
3. **`syscall` 的第三返回值恒非 nil**（`Errno(0)` 也是非 nil）。判错误要用 `errno != 0`，
   不能用 `errno == nil` —— 用错会让"成功分支永不进入"，句柄泄漏（实测踩过）。
4. 新增常量（`MOVEFILE_*` 之类）必须对着官方表核，并写单测钉死值。
```

## 写什么（示例：PowerShell）

```markdown
# ops/ — PowerShell 探针约定

1. **带外判据只认 marker 文件**：GUI 子系统的 stdout 重定向为空，读 stdout 会得到空结论。
2. **存在性判断用 `[IO.File]::Exists`**，不用 `Test-Path`（后者受权限/提供程序影响）。
3. **收尾必须打印 STATE 块**，且只杀自己起的进程（按路径前缀精确匹配）。
```

## 三条纪律

1. **父目录只写通用、子目录只写专属**。父目录里抄一遍子目录的内容 = 每次进这个仓都为它付一次 token。
2. **规则要可判定**（能一条命令验），不要写"注意编码问题"这类无法核查的话。
3. **子目录规则文件超过 ~30 行就该拆**——它和 L0 一样是每轮上下文税。

> 需要"按扩展名跨目录"（文件散落各处、却要各自带不同规则）时见
> [`../../L4-plugins/rules-by-glob/DESIGN.md`](../../L4-plugins/rules-by-glob/DESIGN.md)：
> 技术上可行，但会动到前缀缓存，要先证明规则集足够大。
