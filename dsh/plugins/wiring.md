# 三个自制插件在本机的装配（键名与判据，值以本机为准）

> 权威在 `~/.dsh/profiles/web/cordis.patch.yml` 的 `insert` 段。完整配置示例见各插件目录的
> `config.example.yml`；本文件只记**本机开了哪几项、为什么**。

## tool-guard

| 键 | 本机值 | 为什么 |
|---|---|---|
| `disposeAllow` | `/tmp`、`/var/tmp`、`~/.dsh-work` | 190 条历史拒绝里 46 条是删自己的临时目录 |
| `autoSnapshot` | `true`，上限 8 MB | 97 条闸门拒绝里 52 条目标是文件（最大 36 KB），让人肉拍快照纯属税 |
| `hostServices` | 本机宿主服务名 | 判定"重启 + 后台叠加" |
| `requireSnapshot` | `true` | R-12 的机制层兜底 |
| `enabled` | `true` | 观察期可改 `false`（只记日志不拒） |

## self-recall

| 键 | 本机值 | 为什么 |
|---|---|---|
| `localModels` | 会话可能用到的本地模型全集 | 写死一个 ⇒ 会话切模型后四条回归路径全跳过（踩过） |
| `auxModels` | 视觉/OCR 模型 | 顺序硬要求：辅助模型在场时装主模型会 OOM |
| `warmAfterRun` | `true` | 把 30–45 s 装载吃在调用里 |
| `memFloorMB` / `freeRunMB` | 见 R-07 的说明 | **阈值属本机事实，不进 L0** |
| `shipSkill` | `false` | 纪律已内化进工具描述，不再分发技能 |

## vision-forward

| 键 | 本机值 | 为什么 |
|---|---|---|
| `transcribe` / `replace` | `true` / **`false`** | 图必须活到 `llm/stream` 才会被转录 |
| `maxTokens` | 8192 | 2048 时思考链吃满 ⇒ content 为空（踩过） |
| `nativeVisionModels` | 原生识图的两个条目 | 这些会话里拒绝调 `vision`（图本来就进上下文） |
| `twinModel` | 声明 `input: [text,image]` 的孪生条目 | 缺它就只能改模型声明（影响面更大） |
