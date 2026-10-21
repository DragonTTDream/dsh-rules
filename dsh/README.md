# dsh/ — 本机 DSH 专属配置的镜像

**这个目录不是可移植层。** 上层的 `L0`–`L4` 是"换台机器也能用"的东西；
本目录是"**只对这台机器的这套 DSH 有意义**"的配置——记住它，是为了换了机器/隔了半年还能重建。

## 里面有什么

| 路径 | 是什么 | 同步方式 |
|---|---|---|
| `inventory.md` | **资产索引**：本机 DSH 的每个配置在哪、仓里有没有 | 人维护 |
| `skills.manifest.yml` | 技能 × 模式绑定的单一事实源 | `bin/dsh-sync.sh` |
| `profile/preset-tools.yml` | 5 个预设共用的工具清单 | `bin/dsh-sync.sh` |
| `profile/presets.md` | 5 个预设的结构与理由（值用占位符） | 人维护 |
| `profile/dependencies.md` | 装了哪些插件/bundle | 人维护 |
| `plugins/wiring.md` | 3 个自制插件的本机参数与理由 | 人维护 |
| `tools/snap.sh`、`restore.sh` | 单槽快照工具 | `bin/dsh-sync.sh` |

## 两条规矩

1. **镜像类只允许"本机 → 仓"单向**：改本机文件后用 `bin/dsh-sync.sh` 同步；
   `bin/dsh-sync.sh --check` 会报漂移（也接进了 `bin/sync-check.sh`）。
2. **含本机事实的东西只写摘要不写值**：`cordis.patch.yml`、`package.json` 里有
   `/home/<user>/...`、模型 id、端口——这些只进 `presets.md` / `dependencies.md` / `wiring.md`
   的说明性文字，不进仓的原文。

## 为什么要这一层

散在 `~/.dsh` 里的配置有个致命问题：**它们不在任何版本库里，也不在任何笔记里**。
半年后你只会记得"好像配过什么"。本目录的判据是：**这份东西丢了，换个会话还记得吗？**
记不住就该进 `inventory.md`。
