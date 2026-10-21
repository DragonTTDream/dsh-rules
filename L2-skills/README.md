# L2 · 技能

本目录是 9 个技能的原文，一条命令就能装到自己机器上：

```bash
cp -r L2-skills/<技能名> "$DSH_HOME/skills/"
```

## 注意：这里可能含本机事实

技能是**给某台具体机器写的配方**，所以本层允许出现本机事实（回环端口、本机路径、
模型名）。换机器前先跑 `bin/lint.sh`，它会列出命中处，逐个替换。

| 技能 | 依赖什么 | 换机器要改什么 |
|---|---|---|
| chef | 本地菜谱服务（回环端口） | 端口 / 服务地址 |
| video-transcribe-pipeline | 本地转写模型路径 | 模型目录 |
| stock-analysis-report | 本地数据层 | 数据接口地址 |
| comfyui-workflow-safety | 本机 ComfyUI | 安装路径 |
| 其余 5 个 | 只有工具名，无本机事实 | 一般不用改 |

## 触发条件是症状串

`whenToUse` 里写的应该是**出问题时的原话**（例如"报 Sign in to confirm you're not a bot"），
不是抽象目标。这样用户描述症状时就能命中。
