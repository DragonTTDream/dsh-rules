<!-- incidents/ 的统一形状（借 failure-modes 的「什么坏了 / 怎么级联 / 带走什么」） -->
---
id: INC-YYYY-MM-DD-slug
title: 一句话说清什么坏了
since: YYYY-MM-DD
fault_layer: harness | model | interaction
severity: low | medium | high
---

# <标题>

## 现象
（一句原话 + 一条可复现命令 + 实际 vs 期望）

## 级联路径
（哪些环节让它没被更早发现；用箭头写：A → B → C）

## 根因归属
- `fault_layer`：harness / model / interaction
- 谁、在哪一行、做了什么（指不出 = 只能写"候选机理"）

## 带走什么
- 可复用判据（一句话，能进经验库 INDEX）
- 已下沉的机制（守卫/lint/测试名）；没下沉的写明靠什么守
