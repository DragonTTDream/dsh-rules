---
name: comfyui-workflow-safety
description: ComfyUI 工作流 JSON 的读写与校验约束，覆盖 widgets_values 位置对齐、API 与 GUI 格式转换、装载通道选择。
whenToUse: 生成、转换、校验、装载 ComfyUI 工作流时使用；遇到 widget 值跑到别的输入、"无法转换为 FLOAT"、"Required input is missing"、"Prompt outputs failed validation" 时也用。
---

# ComfyUI 工作流安全（本机实测 + 上游已知缺陷）

## 铁律

**`widgets_values` 是纯位置数组，没有名字。** 第 i 个值落到前端 widget 列表的第 i 位。
任何让 widget 列表「多一格 / 少一格 / 换顺序」的写法都会造成静默错位。
ComfyUI 官方前端与官方模板都带过这类缺陷（见文末），模型没有理由天然知道，必须按规则写。

## 1. widget 对齐 5 条（违反任一条即错位）

1. **未连接的数据口必须保留原类型**（`IMAGE`/`MASK`/`LATENT`/`MODEL`/`CLIP`/`VAE`/`CONDITIONING`/`NOISE`/`SAMPLER`/`SIGMAS`/`GUIDER`/`STEPS`）。
   标成 `"type":"WIDGET"` 会让前端把它当 widget 占位 → 后续所有值**右移一位**。
2. **缺省的 widget 必须补默认值**（从 `/object_info` 里该输入的 `default` 取）。
   跳过不写 → 后续所有值**左移一位**。
3. **前端隐藏的 advanced widget 不占位**：`CLIPLoader.clip_name2`、`CLIPLoader.device`、
   `DualCLIPLoader.clip_name1`、`TripleCLIPLoader.clip_name3`。给它们填值 = 制造空位。
4. **`control_after_generate` 只由前端为核心节点在 `seed` 之后插入**，自定义节点不插。
   校验 widget 数必须两种对齐都试，不能只按 schema 计数。
5. **禁止 `_slotN` 之类的占位输入名**，前端不认。`inputs` 数组必须写 schema 里的真实输入名，
   且**按 schema 顺序、槽位索引一一对齐**（稀疏数组会让连线接错节点）。

## 2. 定点补，不要每次重新生成

> 上游 skill 原话：*Every time you regenerate a workflow from scratch, your conversion script
> will reintroduce the same bugs.*

正确循环：**提交一次 → 读服务端错误 → 定点补 failing 节点 → 重提交**。
服务端 `node_errors` 是事实来源，其中 `extra_info.input_name` 给出**确切的 JSON 键名**，照字面用。

- 点分键名保持原样：`resize_type.width`、`values.a` 是真实键名，**不要拍平成 `width`/`a`**。
- `Reroute` 要 **bypass**（把引用替换成源节点 `[id, slot]`）再删节点，不要直接删。
- 不要"精简"模板节点、sigmas、LoRA 链、conditioning 链 —— 看着没用是设计的一部分。

## 3. 格式区分

| 格式 | 形态 | 用途 |
|---|---|---|
| API 格式 | `{"1": {"class_type":…, "inputs":…}}` | 提交给 `/api/prompt` |
| GUI 格式 | `{"nodes":[…], "links":[…]}` | 前端画布 / 模板 / `user/default/workflows/` |

**API 格式不能当工作流给前端用。** 转换必须依线上 `/object_info` 签名，不能凭记忆。
`object_info` 里 Combo 输入是 `[选项列表, {…}]` —— 类型是**列表**不是字符串，解析时先判。

## 4. 装载进前端（本机唯一可用通道）

`custom_nodes/<包名>/workflows/*.json` → 服务端 `GET /workflow_templates` → 前端「模板」菜单。
**与浏览器无关，重启 ComfyUI 即生效。**

- 前端工作流列表本体在**浏览器 localStorage**，服务端无工作流接口（`GET /api/workflows` → 404）。
  写 localStorage 需独占 leveldb → **必须关闭浏览器** → 浏览器是对话载体时此路**死路**，不要提。
- 模板列表在启动时扫描，改完必须重启才生效。

## 5. 校验清单（写完必过）

- 每条 link 的 target/slot 在 schema 范围内，目标槽未被两条线占用
- `inputs` 数组声明的 link 与实际 links 双向一致
- widget 数 = schema widget 数（±`control_after_generate`）
- **逐位类型核对**：INT/FLOAT 位上出现字符串 → 错位（这是最省事的错位探测器）
- 数据口没有被标成 `WIDGET`

## 6. 本机事实与上游依据

本机路径/版本/自写节点/工具位置，以及已知坑（`ImageScale` 0×0 破坏 latent-mask、`facerestore_models` 未注册、`RestoreFormer++` 在 spandrel 0.4.2 下按设计报错、`gui2api.py` 勿用于稀疏 `inputs` 的历史手写文件）→ `Image/Docs/04-本机事实.md`。

widget 对齐类缺陷的上游同类清单（frontend #14239/#15669、ComfyUI #15102 涉及 113 个官方模板、comfy-cli #790/#722）→ `Image/Docs/05-教训与规则.md`。**纪律只有一条：这类错位是上游结构性缺陷，不是你写错了，所以每次都要过 §5 校验清单。**
