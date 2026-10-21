---
name: video-transcribe-pipeline
description: 本机已验证的视频内容获取 + 语音转写流水线（yt-dlp + 官方字幕 + faster-whisper 本地 medium 模型），含 YouTube 反爬拦截的修复配方与转写稿谐音校正。做 YouTube/B 站视频内容提取、中文语音转写、视频摘要交付时使用。
whenToUse: 需要拿到 YouTube 或 B 站视频讲了什么（字幕/音频/摘要）、yt-dlp 报 "Sign in to confirm you're not a bot" 或只剩故事板格式、需要本地 faster-whisper 转写中文并校正英文技术词谐音时加载本技能。
---

# 视频内容获取 + 语音转写流水线（本机已验证）

> **资源冲突指针**：本机本地 LLM 常驻占 ~48 GB，转写常因内存不足起不来。
> **内存红线、模型卸载/预热、会话自动召回、该不该开子智能体 → 见技能 `local-resource-arbitration`。**
> 本技能只讲"怎么把视频内容拿到手"，资源调度不在本技能内决策。

## 1. 决策顺序（先字幕，后音频，最后才转写）

1. **有官方字幕就不要转写**：`--write-subs --write-auto-subs --sub-langs "zh.*" --sub-format vtt/srv3/best --skip-download`。真人字幕质量远高于 whisper，且零内存成本。
2. 无字幕 → 下载音频 → whisper 转写。
3. 字幕若是"中→英→中"双译机翻，宁可用 whisper 转原始音频。

机翻字幕的两个坑（实测）：
- **滚动重复行**：同句重复 2–3 行，先按"与上一行相同则丢弃"去重，再按 10 条一段合并成可读文本。
- **双译噪声**：中文语音 → 英文字幕 → 回译中文，专名会错（"严复"被写成"严福/颜福"），交付前按标题/简介还原。

## 2. YouTube 抓取（先修工具，别怀疑 IP）

**`--list-formats` 只剩 `sb0..sb3` 故事板 = 缺 EJS 求解器（n-challenge），不是 IP 无解。** 装插件 + 指定 node 作 JS runtime + `player_client=web_embedded` + Edge cookies 即可拿到真实格式：

```bash
python3 -m pip install --user -U "yt-dlp[default,curl-cffi]"
~/.local/bin/yt-dlp --js-runtimes node --cookies-from-browser edge \
  --extractor-args "youtube:player_client=web_embedded" \
  -f "140/251/ba" -x --audio-format wav -o "/tmp/<task>/%(id)s.%(ext)s" "<URL>"
ffmpeg -i /tmp/<task>/<id>.wav -ar 16000 -ac 1 -c:a pcm_s16le /tmp/<task>/<id>.16k.wav -y
```

三条硬规矩：**降采样交给 ffmpeg**（`-af` 塞进 yt-dlp 会被解析成 `-a f` 而报错）；浏览器名写 `edge` 不写 `microsoft-edge`；cookies 用 `--cookies-from-browser` 让 yt-dlp 自己筛（全塞 header → HTTP 413）。

缺什么一眼可见：`yt-dlp -v --simulate --skip-download "<URL>" 2>&1 | grep -iE "pot\]|JavaScript runtime|Sign in|Only images"`。

**client 选型结论**：`web_embedded` 首选（23 个真实格式）；`android` 与 cookies 互斥被跳过；`tv`/`mweb`/`ios` 走不通。**别再逐个重试** —— 完整矩阵、SABR 机制与浏览器截获（CDP）的四个坑见 `Harnessworks/tool-pipeline-reference.md` 2026-10-14 增补。

## 5. B 站

`yt-dlp -x --audio-format mp3 --audio-quality 5 -o out.%(ext)s <bilibili-url>` —— UGC 无需 cookies。

## 6. 转写（faster-whisper + 本地 medium 模型）

- 模型路径：`/home/loong/models_whisper`（`model.bin` 1.5GB / config.json / tokenizer.json / vocabulary.txt）
- **直接传本地目录路径**给 `WhisperModel`，绕开只读的 HF 缓存（`~/.cache`）。
- 推荐参数：
  ```python
  WhisperModel("/home/loong/models_whisper", device="cpu", compute_type="int8", cpu_threads=8)
  m.transcribe(src, language="zh", beam_size=5, vad_filter=True,
               vad_parameters=dict(min_silence_duration_ms=600))
  ```
- 实测速度（int8/8 线程）：507s 音频 → 141s；932s 音频 → 295s。
- 内存档位（int8/CPU 峰值）：`medium` ≈ 3 GB｜`small` ≈ 1.4 GB（模型目录 `/home/loong/models_whisper_small`，464MB）｜`base` ≈ 0.5 GB。
  可用内存不足就降档，不要硬挤 swap（本机 zram 长期占满）。
- **需要独占内存时用插件的 `arbitrate_run` 提交本转写**（卸载模型 → 后台跑 → marker → 自动召回），不要自己写卸载与轮询。
- `small` 档质量代价：中文长句更易出现谐音错字与断句偏差，交付前需按 §10 校正。
- 逐段写盘 + 每 100 段打印进度，便于后台任务观测。

## 7. 谐音校正（交付前必做）

whisper 会把英文/同音词写成常见同音中文，必须按标题、简介、章节名核对修正。本机实测踩到的：

| 转写输出 | 正确 |
|---|---|
| 编辑量 / 编辑收益 / 编辑成本 / 编辑分析 | **边际**量 / 边际收益 / 边际成本 / **边际分析** |
| 理性经纪人 | **理性经济人** |
| 本位经济学 | **行为经济学** |
| 净化留给我们的遗产 | **进化**留给我们的遗产 |
| 双曲贴线 | 双曲**贴现** |
| 量率 | **良率** |
| 菊花 | 华为（口语代称，摘要里还原） |
| 严福 / 颜福 | **严复** |
| 真面设计 / Synopsis | **芯片设计 / Synopsys** |
| 工情时间 / 挤站 / 报饮报食 | 通勤时间 / 挤占 / 暴饮暴食 |

人名术语还原参考：凯利·麦格尼格尔（Kelly McGonigal）、皮尔斯·斯蒂尔（Piers Steel）、乔治·安斯利（George Ainslie）、费斯廷格（Festinger）、卡尼曼 & 特沃斯基（规划谬误）、Hershfield（未来自我连续性）。

## 8. 执行与交付约定

- 长任务（下载/转写）一律后台跑；**不要开子智能体**（本机单模型，抢同一份资源，理由见 `local-resource-arbitration` §5）。
- 临时产物进 `/tmp/<task>/`，不进工作区；交付后逐个核对绝对路径只删本次垃圾，并停掉自己起的 headless 浏览器。
- 摘要交付用 `present` 交 markdown；摘要里注明每片材料来源（官方字幕 / whisper 转写）与已做的谐音校正。
- 沙箱：写 `~/.local`、`~/.dsh` 等 home 位置按当前会话文件策略执行；策略为只读时先向用户说明并取得批准，不要绕过。

## 9. 重下模型（仅当 /home/loong/models_whisper 缺失）

`curl -O https://modelscope.cn/models/pengzhendong/faster-whisper-medium/resolve/main/<file>`
文件：model.bin(1.5GB)/config.json/tokenizer.json/vocabulary.txt；约 1MB/s，后台跑并汇报进度。
