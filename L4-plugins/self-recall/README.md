# self-recall — 会话保活 + 串行资源仲裁

本机只有一个本地推理端点，模型按需装载，加载一次几十秒到几十 GB 内存。
这个插件解决两件事：

1. **保活**：模型请求失败就按指数退避重试，直到装回来（会话不会因为换载而"死"）。
2. **仲裁**：跑重活之前把模型卸掉腾内存，跑完自动装回并预热，把装载耗时吃在工具调用里。

## 注入点

```js
export const inject = ["tools"];
```

只挂 `ctx.tools`，提供三个工具：

| 工具 | 作用 |
|---|---|
| `arbitrate_run` | 卸模型 → `setsid` 后台起脚本 → 轮询 marker → 返回结果 → 自动回归预热 |
| `arbitrate_warm` | 主动把模型装回来（发 1 token 请求触发装载） |
| `arbitrate_status` | 看装载状态、`MemAvailable`、`SwapFree` 与红黄绿判定 |

## 核心机制（改代码前必须理解）

| 机制 | 为什么存在 |
|---|---|
| **待回归四层闭环** | marker 到手后：① 任务脚本自带 EXIT trap 回归 ② 插件定时器扫 pending ③ 回合开始前补 warm ④ 超时分支判迟到 marker。四层任一成功即可，**任务进程还在跑时四层全部不得装回** |
| **`localModels` 跟随会话** | 写死一个模型名 ⇒ 会话切到别的本地模型后，四条回归路径全跳过（曾经实测踩过），重活前腾不出内存、跑完没人装回 |
| **`auxModels` 谁卸谁** | 辅助模型在场时装主模型会 OOM；顺序是硬要求 |
| **`warmAfterRun`** | 把 30–45 s 的装载耗时吃在 `arbitrate_run` 调用里，用户下一条消息直接命中热模型 |
| **`pending` 落盘** | 卸载成功即写标记。这样"插件被放弃调用"也不会留在半卸载状态 |

## 失效症状

| 症状 | 先查 |
|---|---|
| 重活前没腾出内存（`MemAvailable` 没涨） | `localModels` 是否包含会话当前模型；`routeIsLocal` 判定 |
| 跑完下一条消息仍付 30–45 s 冷装 | `warmAfterRun`、`pending` 标记、定时器 `pendingScanMs` |
| 模型被卸了没装回（会话像死了一样） | 待回归四层哪一层断了；`arbitrate_status` 的 pending |
| 主模型装载 OOM | `auxModels` 是否先卸了 |

## 配置

见 [`config.example.yml`](config.example.yml)（22 个键全覆盖）。

## 恢复配方

```bash
# 临时停用（不删插件）
#   在 profile 的 config 里把该条目加 disabled: true，然后重启宿主
# 彻底回退
#   删掉 cordis.patch.yml 里的 insert 段 + 重启宿主
# 本仓代码覆盖回本机（注意：要把 config 一起带上，否则 endpoint 为空）
cp self-recall/index.js ~/dsh-self-recall/index.js
```

## 免责：它动你的内存

这是唯一一个会主动**卸载用户正在用的模型**的插件。改它的判据前先读一遍
`localModels` 的判定顺序，否则会出现"会话被自己的插件拖死"的形态。
