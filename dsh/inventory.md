# 本机 DSH 资产索引

> 判据：**这份东西丢了，换个会话还记得吗？** 记不住就该进仓。
> 状态列：`镜像` = 仓里有副本（`bin/dsh-sync.sh` 单向同步）、`摘要` = 仓里只有人读说明、
> `不收` = 社区插件产物/会话数据，不属配置。

## 一、必须记住的配置

| 本机路径 | 是什么 | 状态 | 仓内位置 |
|---|---|---|---|
| `~/.dsh/AGENTS.md` | 每轮注入的常驻规则（15 条） | 镜像（由 L0 合成） | `L0-always-on/` + `bin/assemble.sh` |
| `~/.dsh/skills/` | 10 个技能真源 | 镜像（逐字） | `L2-skills/` |
| `~/.dsh/skills.manifest.yml` | 技能×模式绑定 | **镜像** | `dsh/skills.manifest.yml` |
| `~/.dsh/skillsets/` | 5 个模式的技能目录（物化产物） | 不收（可重建） | 由 manifest 生成 |
| `~/.dsh/profiles/web/preset-tools.yml` | 5 个预设共用的工具清单 | **镜像** | `dsh/profile/preset-tools.yml` |
| `~/.dsh/profiles/web/cordis.patch.yml` | 全部装配（模型/插件/预设） | **摘要**（含本机路径，不公开） | `dsh/profile/presets.md`、`dsh/plugins/wiring.md` |
| `~/.dsh/profiles/web/package.json` | 依赖与 bundle 清单 | **摘要**（link 路径是本机的） | `dsh/profile/dependencies.md` |
| `~/.dsh/snapshots/{snap,restore}.sh` | 单槽快照工具 | **镜像** | `dsh/tools/` |
| `~/dsh-{self-recall,vision-forward,tool-guard}/` | 3 个自制插件 | 镜像（脱敏） | `L3-guards/`、`L4-plugins/` |

## 二、只写摘要、不进仓的（含本机事实）

| 项 | 为什么不收 | 在哪能回忆起来 |
|---|---|---|
| 模型 id / 端点 / 端口 | 属本机事实，公开仓不该有 | `dsh/profile/presets.md`（只写结构，值用占位符） |
| `disposeAllow` / `autoSnapshot` 等插件参数 | 同上 | `dsh/plugins/wiring.md`（键名 + 取值示例） |
| 各工作区 `AGENTS.md` / `MEMORY.md` | 属现场状态，不是配置 | 各工作区自己的目录 |

## 三、明确不收

`~/.dsh/sessions/`（会话）、`attachments/`、`logs/`、`snapshots/*.tar.gz`、`backups/`、
`profiles/*/node_modules/`、社区插件的运行态（`guardian/`、`token-monitor/`、凭据库目录）。

## 四、恢复顺序（换机或重装时照着走）

1. 装 DSH + 在 profile 里装回 `dsh/profile/dependencies.md` 列的 bundle/插件
2. `bin/skills-apply.sh --apply` 物化技能目录
3. `bin/assemble.sh > ~/.dsh/AGENTS.md`
4. 按 `dsh/profile/presets.md` 重建 5 个预设；按 `dsh/plugins/wiring.md` 填插件参数
5. 跑一遍自检：`lint` / `conflict-check` / `skill-triggers` / `sync-check`
