# Agent 预设 × 技能：现状诊断与优化建议

> 诊断时间：2026-10-21。数据是实测的（遍历 `~/.dsh/skillsets/` 与 `cordis.patch.yml`），不是推测。

## 一、现状矩阵

`S`=软链、`Fg`=生成的副本（多一行 `disable-model-invocation: true`）、`.`=看不到

| skillset | chef | code-edit | comfyui | debug | github-axi | shell | skill-auth | stock | video | hygiene |
|---|---|---|---|---|---|---|---|---|---|---|
| chef | S | . | . | . | . | S | . | . | . | S |
| comfyui-workflow-safety | . | . | S | . | . | S | . | . | . | S |
| general | **Fg** | S | **Fg** | S | S | S | S | **Fg** | **Fg** | S |
| stock-analysis-report | . | . | . | . | . | S | . | S | . | S |
| video-transcribe-pipeline | . | . | . | . | . | S | . | . | S | S |

## 二、六个结构问题

1. **两种机制混用**：`general` 里 4 个是生成的副本、5 个是软链。什么时候该软链、什么时候该生成副本，没有规则可循——只有 `skillsets/regenerate.sh` 里硬编码的 `FLAGGED` 数组。
2. **新增技能要手工挂 N 处**：加 `debug-discipline` 时我只挂了 `general`，其余 4 个模式漏掉；**股票/视频/ComfyUI 模式里恰恰最需要调试清单**。
3. **模式间不对称无人能判**：`code-edit-lane` / `github-axi` / `skill-authoring` 只出现在 `general`。是设计（那三类活只在普通模式做）还是遗漏？没有单一文件能回答。
4. **`disable-model-invocation` 只活在副本里**：源文件没有这个 flag ⇒ 同一技能有两份正文来源，且只有 4 个受管。
5. **只能反推，没有正查**：想知道"某模式看得到哪些技能"，只能像上面那样跑脚本遍历目录。
6. **`includeDefaultRoots: false`** 意味着主机层技能根被切断——**加技能时必须改 skillsets，改仓库不管用**，这一点在文档里没写明。

## 三、优化建议：一份 manifest + 两个脚本

把"谁在哪个模式里、以什么方式暴露"从**目录结构**里抽出来，变成**一份声明**。

```yaml
# ~/.dsh/skills.manifest.yml —— 单一事实源
skills:
  workspace-hygiene:         { modes: [all], expose: auto }
  process-shell-safety:      { modes: [all], expose: auto }
  debug-discipline:          { modes: [all], expose: auto }
  skill-authoring:           { modes: [all], expose: auto }
  github-axi:                { modes: [all], expose: auto }
  code-edit-lane:            { modes: [all], expose: auto }
  chef:                      { modes: [chef, general],                      expose: command }
  stock-analysis-report:     { modes: [stock-analysis-report, general],     expose: command }
  video-transcribe-pipeline: { modes: [video-transcribe-pipeline, general], expose: command }
  comfyui-workflow-safety:   { modes: [comfyui-workflow-safety, general],   expose: command }
```

- `expose: auto` —— 模型可自选（软链即可）
- `expose: command` —— 只允许 `/名字` 调用（生成副本并注入 `disable-model-invocation: true`）

**`bin/skills-apply.sh`**：读 manifest → 物化 `skillsets/<mode>/`（软链或副本），默认 `--dry-run`，加 `--prune` 才删多余项。
**`bin/skills-lint.sh`**：manifest ↔ 实际目录一致性；孤儿技能（存在但没进 manifest）；某模式引用了不存在的技能。

三条硬规则（写进 lint）：

1. `skills/` 下的每个技能**必须**在 manifest 里出现，否则报孤儿。
2. 每个模式的目录内容必须与 manifest 推导出的集合**逐项相等**。
3. `expose: command` 的技能，其副本必须含 `disable-model-invocation: true`；`expose: auto` 的**必须不含**。

## 四、迁移步骤（每步一个判据）

| 步 | 动作 | 判据 |
|---|---|---|
| 1 | 从现在目录反推出 manifest | `skills-apply.sh --dry-run` 输出"无变更"——证明 manifest 忠实描述现状 |
| 2 | 把 `regenerate.sh` 的 `FLAGGED` 数组删掉，由 manifest 取代 | 生成副本内容与手写副本逐字一致 |
| 3 | 打开 `--prune` 跑一次 | 目录与 manifest 完全一致；`skills-lint.sh` 绿 |
| 4 | 把 `skills-apply.sh` 接进 DSH 启动前的闸门 | 改 manifest → 一条命令 → 重启后模式里可见性正确 |

## 五、现在就能做的三件小事（不等迁移）

1. **补挂 `debug-discipline`** 到 stock / video / comfyui 三个模式（已做）。
2. **在 `cordis.patch.yml` 的 preset 注释里写明**：`includeDefaultRoots: false` ⇒ 新技能必须改 `skillsets/`，改仓库无效。
3. **把 `regenerate.sh` 的 `FLAGGED` 数组加一行注释**：它是 manifest 的临时替身，不是设计。

## 六、不做什么

- 不动内置模式（`standard` / `ptc` / `minimal` / `cordis`）——它们的技能表来自 web-app bundle，改了会被下次更新冲掉。
- 不引入 YAML 之外的格式（TOML/JSON）：本机的编辑链一直是 YAML。
