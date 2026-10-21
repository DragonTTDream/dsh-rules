---
id: INC-YYYY-MM-DD-<短名>
date: YYYY-MM-DD
status: verbatim        # verbatim=有逐字原话/记录；observed=现象反复出现但无单次记录
severity: high          # high | medium | low
layer_missed: L0        # 哪一层本该拦住它
rules: [R-xx]           # 由它催生或应强化哪些规则
source: <用户原话 / 复盘清单 / 实测记录>
---
## 症状

模型做了什么、当时看起来像什么。

## 事实（原话或可核对的观测）

逐字引用。没有逐字记录就写 `status: observed`，不要编。

## 哪层漏了

L0 / L1 / L1.5 / L2 / L3 —— 并说明为什么是这一层而不是别的层。

## 修补

改了什么（规则 id / 技能 / 守卫），只写实际改动的。

## 回归

同一错再发生时，怎么被自动或半自动抓出来。
