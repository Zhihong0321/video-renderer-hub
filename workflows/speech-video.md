# Workflow: 带语音旁白的视频生成（音频先行）

> 给 AI agent 的标准作业流程。核心原则：**音频是节奏的主人**——先生成旁白、量出真实时长，
> 再据此决定每页画面的时长。禁止先定画面时长再"塞"语音（会溢出/漂移）。

## 适用场景

用户要一条"有画面 + 有中文/英文旁白"的视频：日报、解读、产品介绍、数据汇报等。

## 前置条件（执行前自检）

```bash
mmx auth status        # mmx-cli 已认证（MiniMax API key）
ffmpeg -version        # ffmpeg + ffprobe 在 PATH 上
ls packages/adapter-hyperframes/dist/index.js   # adapter 已 build（否则 pnpm -r build）
```

## 流程总览

```
① 写文案        每页一段旁白（中文 80–120 字 ≈ 20–30s 语音；短页 30–50 字）
② 做幻灯片      每页一个自包含 HTML（CSS @keyframes 入场动画，详见下文规则）
③ 写 manifest   sections 数组：id + html + narration
④ 跑 driver     node scripts/make-speech-video.mjs <manifest.json>
                （driver 自动完成：TTS → 量时长 → 推导每页时长 → 逐帧渲染 →
                  concat → 按计算好的偏移混音）
⑤ 验证          ffprobe 总时长 / mpdecimate 数独立帧 / 抽听首尾段
```

## ① 写文案

- 每个 section 一段旁白，**一段话讲完一页的事**。
- 可用 `mmx text chat --model MiniMax-M3` 生成初稿，但要人审：TTS 会照读一切，
  删掉序号、括号注释、英文缩写改写成可读形式（"VPS" → "V P S"）。
- 无旁白的页（封面/尾板）不写 narration，在 manifest 里给固定 `durationSec`。

## ② 做幻灯片 HTML

每页一个**自包含** HTML 文件，规则：

- **系统字体栈优先**（`"PingFang SC", "Microsoft YaHei", system-ui, sans-serif`）。
  用 Google Fonts 也可以（渲染器会等字体），但会拖慢每页渲染启动。
- 动画用 **CSS `@keyframes` + `forwards`**，或 GSAP——渲染器是确定性逐帧驱动
  （WAAPI seek + 虚拟时钟），两者都精确支持。
- 入场动画总长（duration+delay）**不要超过该页旁白时长**——
  画面动完、声音还在讲是对的；声音讲完了画面还没动完是错的。
  估算：中文语速 ≈ 4 字/秒，80 字 ≈ 20s。
- 循环背景动画用 `animation-iteration-count: infinite`（时长探测会忽略它，不影响页长）。
- 1920×1080 设计，不要依赖外部网络资源（图片 base64 内联）。

## ③ 写 manifest

```json
{
  "output": "out/my-video/final.mp4",
  "fps": 60,
  "resolution": { "width": 1920, "height": 1080 },
  "voice": "presenter_male",
  "language": "Chinese",
  "speechSpeed": 1.0,
  "leadInSec": 0.6,
  "tailSec": 0.6,
  "minSlideSec": 4,
  "sections": [
    { "id": "cover", "html": "slides/cover.html", "durationSec": 4 },
    { "id": "s1", "html": "slides/s1.html", "narration": "第一页的旁白……" },
    { "id": "s2", "html": "slides/s2.html", "narration": "第二页的旁白……" },
    { "id": "outro", "html": "slides/outro.html", "durationSec": 4 }
  ]
}
```

- 路径相对 manifest 文件所在目录。
- 常用中文 voice：`presenter_male`（男主持）、`female-chengshu`（成熟女声）、
  `audiobook_male_2`、`female-yujie`。英文用 `English_expressive_narrator`。
- 时长公式（driver 自动算，无需手填）：
  `页长 = max(minSlideSec, leadInSec + 语音实测时长 + tailSec)`，
  语音起点 = 该页视频起点 + leadInSec。

## ④ 跑 driver

```bash
node scripts/make-speech-video.mjs path/to/manifest.json
```

- TTS 结果缓存在 `<output目录>/.speech-video-work/tts/<id>.mp3`——改了某页文案就删对应
  mp3 再跑；只改 HTML 不动文案则 TTS 全部复用（省钱省时）。
- 渲染成本 ≈ **0.3s/帧**（60fps 即 ≈18s 渲染换 1s 成片）。长视频先用 `"fps": 30` 出草稿，
  终稿再切回 60。
- driver 结束时打印完整时间线（每页起点 + 语音区间），核对它而不是猜。

## ⑤ 验证（必做，不能只看文件生成）

```bash
# 总时长 = driver 打印的 total，误差 < 0.05s
ffprobe -v error -show_entries format=duration -of default=nw=1:nk=1 out/my-video/final.mp4

# 流畅度：数独立帧（容器 fps 是标称，不可信）。动画段应有每秒几十个独立帧
ffmpeg -ss <动画段起点> -t 5 -i out/my-video/final.mp4 -vf mpdecimate -an -f null -

# 音画对位：抽第一个和最后一个有旁白的页，截该页起点 + leadIn 处的 3s 听一下
ffmpeg -ss <audioStart> -t 3 -i out/my-video/final.mp4 -vn check.aac
```

## 常见错误

| 症状 | 原因 | 修法 |
|---|---|---|
| 语音被下一页"截断" | 没走本流程，手填了页长 | 永远让 driver 从实测语音推页长 |
| 某页画面早早静止干等 | 旁白太长 / 入场动画太短 | 拆成两页，或给页面加阶段性动画 |
| 输出"60fps"仍卡顿 | 没用新渲染器（webm 录屏旧版本） | 确认 adapter ≥ `0.3.0-framestep`，重新 `pnpm -r build` |
| TTS 读错缩写/符号 | 文案没为"读"优化 | 文案审一遍：缩写拆字母、去括号、数字写读法 |
| 总时长对但中段错位 | 手改过某段 mp4 后没重跑 concat | 任何改动后整条重跑 driver（除 TTS 外都很快） |

## 进阶：页内动画跟读到哪儿（可选）

`mmx speech synthesize --subtitles` 会在 mp3 旁输出 `.srt`（句级时间戳）。
要做"念到哪条 bullet 哪条亮"：读该页的 srt，把每句的起始时间写进对应元素的
`animation-delay`，再渲染。这是页级增强，不影响上面的主流程。

---

*2026-06-13 建立。依赖 adapter-hyperframes `0.3.0-framestep`（确定性逐帧渲染，
explicit 时长精确到帧），这是音画不漂移的前提。*
