---
name: chef
description: 本机已部署的私人大厨。364 道菜谱 + 3522 张图 + 18 份厨房教程全部本地化，跑在容器 chef 里（http://127.0.0.1:2111），带厨具/忌口/过敏/难度/耗时/卡路里硬过滤与 14 天去重。
whenToUse: 需要选菜/菜谱/教程/采购清单/一周计划时用（MCP 工具 mcp__chef__* 在时直接调用，无需加载本技能）；用户说「今天吃什么」「做什么菜」「饿了」「辣的/清淡的/快手」「买菜」「一周吃什么」「这道菜怎么做」「焯水/糖色/油温怎么做」，或要求把菜谱与步骤图交付成图片/PDF 时加载本技能。
---

# 私人大厨（本机已部署，断网可用）

## 铁律（不可违反）
**LLM 不是烹饪事实的来源。** 食材、用量、步骤、时长、火候、教程文字一律 100% 来自本地 API 返回的原文，逐字引用。禁止凭常识补写菜谱、禁止改写用量、禁止编造步骤。API 没返回的，就说没有。

## 0. 首选：MCP 工具（工具在时不用 curl）
harness 已注册 MCP 服务 `chef`（stdio，`~/kaoyan/chef/tools/chef_mcp.py`），工具名：

| 工具 | 干什么 |
|---|---|
| `mcp__chef__chef_health` | 容器与数据是否就绪 |
| `mcp__chef__chef_eat` | 按口味 + 本机画像选菜（硬过滤 + 去重） |
| `mcp__chef__chef_recipe` | 一道菜的完整原文（食材用量 / 步骤计时 / 图 / 实拍） |
| `mcp__chef__chef_search` | 按菜名 / 标签 / 食材 / 步骤正文搜菜（相关性排序） |
| `mcp__chef__chef_photos` | 真人实拍 |
| `mcp__chef__chef_tips` `chef_tip` `chef_glossary` | 18 篇教程与 31 条术语映射 |
| `mcp__chef__chef_plan` `chef_shopping` `chef_profile` `chef_agent` | 一周计划 / 采购清单 / 画像 / 界面同款 AI 选菜 |

工具返回的就是本地原文，逐字引用。工具不可用时（未重启 harness）退回下面 §0 的 curl 路径。

## 0. 服务在不在（MCP 工具不可用时的退回路径）
```bash
curl -s --max-time 5 http://127.0.0.1:2111/api/v1/chef/health
```
- 通 → 直接用。
- 不通 → `docker start chef`（容器已存在，数据 bind mount 在 `~/kaoyan/chef/data`）。
- 容器不在 → 宿主机直跑：`bash ~/kaoyan/chef/tools/dev_run.sh`（同样 2111）。
- 停：`bash ~/kaoyan/chef/tools/dev_stop.sh`。不常驻，用完可停。

## 1. 选菜（最常用）
```bash
curl -s "http://127.0.0.1:2111/api/v1/chef/eat?mood=辣,快手&limit=5&explain=true"
```
`mood` 可用词：辣 / 清淡 / 下饭 / 快手 / 汤 / 甜 / 素 / 硬菜 / 早餐 / 面食（其它词按标签子串匹配）。
返回每项含 `id title category difficulty duration_min calories tags cover_image overview_image appliances pantry_coverage score`。
`explain=true` 额外给 `rejected`（被剔除的菜 + 原因），用户质疑「为什么没有烤 X」时拿这个回答。

**交付方式**：取 top1，把 `id` 交给第 2 节拉全文，然后 present 图片。

## 2. 菜谱全文（原文，逐字引用）
```bash
curl -s "http://127.0.0.1:2111/api/v1/recipes/<id>"
```
字段：`ingredients[{name,amount,buying_tip,optional,per_serving}]`、`tools[]`、`servings{base,formula}`、
`steps[{index,title,instruction,duration_sec,tips[],image}]`、`tips[]`、`cover_image`、`overview_image`、`photos[]`。
`duration_sec` 是单步计时，做「跟着做」时按步给出。
`photos[]` 是该菜的真人实拍（上游作者自己做的成品照，做出来对照用），运行时注入，可能为空；有就一并给用户。

## 3. 图片（全本地，直接 present）
| 用途 | 路径 |
|---|---|
| 封面 | `~/kaoyan/chef/data/img/cover/<id>.webp` |
| 全解图（一图看懂，文字密集） | `~/kaoyan/chef/data/img/overview/<id>.webp` |
| 分步图 | `~/kaoyan/chef/data/img/steps/<id>/step_N.webp` |
| 真人实拍 | 详情接口的 `photos[]` 已给出（= `data/img/photo/<分类>/<菜名>/*.webp`）|

浏览器里对应 `http://127.0.0.1:2111/img/...`。
界面「AI 选菜」后端：`POST /api/v1/chef/agent {messages:[...]}` → **官方 recipe-finder 两阶段协议**（规划器出检索计划 JSON → 本机检索 + 画像硬过滤 → 主厨从候选挑并写理由），输出 SSE：`trace`(intent/search/rank/answer) / `delta` / `complete`。候选只来自本机检索，模型只挑与给理由，候选里没有的菜直接丢弃。

## 4. 教程（18 份，上游原文）
```bash
curl -s http://127.0.0.1:2111/api/v1/chef/tips            # 索引
curl -s http://127.0.0.1:2111/api/v1/chef/tips/学习焯水     # 单份（含 content 原文）
curl -s http://127.0.0.1:2111/api/v1/chef/glossary        # 术语→教程 映射 31 条
```
分组：入门(厨房准备/如何洗碗/如何选择现在吃什么) · 技法(炒与煎/蒸/煮/焯水/腌/凉拌) ·
器具(空气炸锅/高压力锅/微波炉) · 安全(食品安全/去腥) · 进阶(油温判断/糖色的炒制/辅料技巧/高级专业术语)。
菜谱里出现「焯水/糖色/油温/勾芡/码味」等术语时，**顺手把对应教程一起给**（glossary 就是干这个的）。
网页版：`http://127.0.0.1:2111/tips/`

## 5. 用户画像（约束引擎的输入）
文件 `~/kaoyan/chef/data/profile/profile.json`，改完刷新即生效（或 POST `/api/v1/chef/profile`）。
- `tools`：**空数组 = 不做厨具过滤**。填了则只出「所需大家电全在列表内」的菜。
  可填：炒锅 蒸锅 煮锅 烤箱 空气炸锅 微波炉 高压锅 砂锅 平底煎锅 烧烤架 料理机 电饭煲。
  菜刀/砧板/碗筷视为常备，永不过滤。
- `avoid_ingredients` / `allergies`：命中食材名或菜名子串 → 整菜剔除。
- `max_difficulty`(1-5) / `kitchen_time_budget_min` / `calories_per_person_max`：超限剔除。
- `dedup_days`：默认 14 天，吃过的菜降权。
- 库存：`/api/v1/chef/pantry` POST `{"items":{"鸡蛋":12,...}}`，命中越多分越高。

## 6. 其它能力
```bash
# 一周计划 + 采购清单（自动排除饮料/酱料/甜品占位）
curl -s "http://127.0.0.1:2111/api/v1/chef/plan?days=7"
# 指定菜的采购清单（按 servings.formula 缩放人份）
curl -s "http://127.0.0.1:2111/api/v1/chef/shopping?ids=other_ma-po-dou-fu,vegetable_dish_liang-ban-huang-gua&people=2"
# 吃过记录（喂给去重）
curl -s -X POST "http://127.0.0.1:2111/api/v1/chef/history?id=other_ma-po-dou-fu"
```
网页版：`http://127.0.0.1:2111/`（菜谱墙 364 卡）· `/eat/`（选菜+改约束）· `/recipe/<id>/cook/`（全屏跟着做+计时）

## 7. 坑
- `calories` 是**整道菜**的口径，不是单人份；报卡路里时说明这点。
- `duration_min` 含腌制/浸泡，2880 分这类是发酵腌制品，不是做饭时长。
- 图缺 → 先 `python3 ~/kaoyan/chef/tools/fetch_images.py all` 再 `python3 ~/kaoyan/chef/tools/compress_images.py all`。
- 数据源：`~/kaoyan/chef/data/merged/recipes.json`（364 条，上游 dataset 分支原文）。
- 上游菜谱原文：`~/kaoyan/chef/src/howtocook/dishes/**/*.md`（要更细的原文/更多实拍图时读这里）。
