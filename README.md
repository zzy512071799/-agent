# manju-agent

漫剧生产的主控 agent。上游吃 storyforge（剧本 agent）的小说 + 设定，下游产出
**剧本 + 参考图 + 分镜图 + 视频 prompt**，人工上传到 Seedance / H3 出片。

三个 agent 的分工：

```
storyforge (Python MCP)          manju-agent (本项目)                 外部音视频模型
小说正文 + meta.json      →      改编 script.json                →   Seedance 2.5
角色 appearance / 分集大纲        分镜 shots + imagePrompt              MiniMax H3
                                 参考图 + 分镜图
                                 场景 prompt（中文，含台词/音效/配乐）
```

`分镜师agent/` 是空目录。它的职责已经落在 `src/core/pipeline/storyboard.ts` 里，
不需要单独一个 agent：分镜要同时看到全剧本、角色 appearance 和图像 prompt 模板，
拆出去就要把这三样再传一遍。

## 为什么主 agent 是这个

数据的收敛点在这里。`storage/works/<作品名>/` 是唯一有完整状态的地方
（`script.json` + `images/` + `export/`），剧本 agent 只管到小说，视频模型只吃一次性 prompt。
谁持有状态谁做编排。

## 四段流水线

```
改编  adapt.ts     meta.json → script.json（角色 + 8 个片段 + artStyle + musicDirection）
分镜  storyboard.ts 每段 → shots[]（景别/运镜/时长/台词/情绪/音效 + imagePrompt），每段合计 15s
出图  images.ts     角色参考图（四视图） + 场景参考图 + 逐镜分镜图
导出  export.ts     export/{分镜表.md, 角色/, 场景/, 分镜图/, 片段prompt/}
```

每段都落盘、都可单独重跑。`create.ts` 会先检查 `script.json` 是否存在，
存在就跳过改编——改编一次 ~50s，重跑时白烧这一刀没意义。

**改编不是字段映射。** storyforge 的 `meta.json` 里 `beats` 经常一条横跨好几个地点，
直接映射成场景会得到"一个场景在三个地方"，图生成不出来。所以 `adapt.ts` 走 LLM 真改编，
硬规则是「一个场景 = 同一地点 + 同一时段」。

## 两个一致性锚点

跨镜头、跨场景的一致性不能靠模型自觉，得靠字段。

- **`Character.appearance`** — 形象锚点，英文，具体到发型/服装/体型。
  每张分镜图的 prompt 里**逐字原样抄进去**，不压缩不改写（`storyboard.ts:44`）。
  一改写就是另一个人。
- **`Character.voice`** — 声音锚点，中文，四要素：年龄段 + 性别 + 音高 + 音色 + 语速。
  音视频联合生成的模型是从文字描述里推嗓子的，不写就每场抽一个不同的声音，
  62 岁的老人能出来个年轻男声。`voice` 只在角色第一次说话时注入 prompt，之后靠 `(S1)` 复用。

`voice` 用 `default('')` 而不是必填：老作品的 `script.json` 没这个字段，
缺失时降级成只报语气，不该让整个作品读不出来。

## prompt 是代码拼的，不是 LLM 写的

`storyboard.ts:14-17`。让 LLM 直接写 imagePrompt，它会写"林澈站在书架前"——
图像模型不知道林澈是谁。所以 LLM 只填结构化字段（`actionEn` / `shotSize` / `characters`），
prompt 由代码按固定顺序拼：

```
artStyle → 景别短语 → actionEn → {id}: {appearance} 逐角色 → location → 时段短语
```

角色标签用 `id`（`lin-chen`）不用中文 `name`。英文 prompt 里夹中文是纯噪声。

`artStyle` 禁用 `cinematic / dramatic / beautiful / emotional / consistent` 这类抽象词，
只写看得见的特征。抽象词对图像模型等于没写。

**`artStyle` 是画风的唯一开关，但改它不够。** `imagePrompt` 是分镜阶段拼好落盘的，
画风被冻在字符串里。实测把 `artStyle` 换成真人后只重跑出图：参考图（文生图，现拼 prompt）
出来是真人，分镜图（图生图，读落盘的 `imagePrompt`）还是二次元。所以 `create.ts` 复用
已有 `script.json` 时会按当前 `artStyle` 重拼一遍 `imagePrompt`。

**画风的否定词要放 `negativePrompt`，别写进 `artStyle`。**
`artStyle` 里写 `not illustration, not anime` 反而会把 anime 召唤出来 —— 正面 prompt 里
出现的概念就是概念，模型不做否定。`negativePrompt` 会被 provider 拼成 `Avoid: ...`。

## H3 的提示词规范不是"换个措辞"

主力视频模型是 MiniMax H3，走**全能参考（Ref2VA）**，编译器在 `src/core/pipeline/h3.ts`。
Seedance 的编译器（`seedance.ts`）留着，`npm run export -- --target seedance` 切过去。
两家不共用一份 prompt，因为差异是结构性的：

- H3 是**六段固定结构**：`subject_definitions` / `summary` / `retention_analysis` /
  `detailed_description` / `overall_soundscape` / `non_diegetic_music`，顺序不能改
- H3 要求**正文写英文**，只有台词和画面内可见文字保留原语言，台词包在
  `<d>[Chinese] ...</d>` 里
- 角色靠 `<Subject N>` 标签跨镜绑定，具体帧靠 `<Picture N>`。所以任务类型是
  `[keyframe completion + reference generation]`：段首分镜图当 `[Shot 1]` 首帧，
  角色卡和场景图当 Subject
- 运镜必须用官方词表（`Push In` / `Truck Left` / `Arc Shot`…）+ 幅度 + 速度，
  自造词会退化成"随便动一下"
- 旁白必须用固定短语 `says in an off-screen voiceover`，紧跟一句"画面里所有人嘴唇闭合"，
  否则在场角色会跟着旁白开口
- 切镜时间戳 `[Shot N] At MM:SS.mmm`，严格递增

**为什么不用 I2VA**：I2VA 只吃一张首帧图，角色四视图卡就浪费了。一致性锚点是这条
流水线的核心资产，必须走能声明 Subject 的模式。

**H3 单次上限 15 秒**，正好等于一个片段 —— 8×15 这个划分同时满足 H3（≤15s）
和 Seedance（≤30s）。

### 中英各存一份

`Shot.motionPromptEn` / `Shot.sfxEn` / `Character.voiceEn` / `Script.musicDirectionEn`
是英文版字段，分镜和改编时一起生成。不是只留英文：Seedance 是中文母语模型，
中文提示词更准，两条路都得留着。

老作品这些字段是空的，`npm run create -- --work "名" --fill-en` 补一遍（一次 LLM 调用，
只翻译不改写）。为什么不直接重拆分镜：那会换掉镜头数量，已生成的分镜图全作废。

英文里**不能出现角色名**（拼音也不行）。H3 靠 `<Subject N>` 绑定角色，出现
"Su Yan" 会被当成一个没声明过的新实体。提示词里已经禁了，`h3.ts` 里还有一道
兜底替换（角色 id 是拼音短横线形式，反推出人名做替换）。

## 9:16 的白画布 trick

`image.ts:119-136`。`gpt-image-2` 的尺寸控制不可靠，直接要 9:16 会给回 1536×1024。
做法是塞一张 9:16 的纯白底图当参考走 `/v1/images/edits`，用参考图的比例把输出掰过来。

## 一集 = 8 段 × 15 秒

交付单位是"段"，不是"场景"，也不是"镜头"：

```
一集 = 8 段 = 120 秒
一段 = 15 秒 = 一个场景 = 一次视频生成 = export/片段prompt/ 里的一个文件
```

以前场景时长是 8-28 秒的自由值，结果每集总长随机（实测第 1 集 6 场 84 秒），
既拼不出固定片长，人工上传时也数不清该传几次。定成 8×15 之后场景、片段、文件、
生成任务四者一一对应，`片段prompt/` 里就是 `01-xxx.txt` 到 `08-xxx.txt`，按序号传完就是一集。

15 秒还落在两个模型的公共区间里：Seedance 单次 ≤30s，H3 ≤15s。

常量在 `storyboard.ts`：`SEGMENT_SEC = 15`、`SEGMENTS_PER_EPISODE = 8`。改这两个数，
改编提示词、分镜约束、导出表头会一起跟着变。约束由提示词下发 + 代码复核，
偏离只告警不自动改 —— 加哪个空镜、压哪个镜头是创作决定。

## 安装

```bash
cd /Users/zhangzhiyu/Desktop/创作/漫剧agent
npm install
cp .env.example .env
```

## 两套网关，别搞混

文本和图像走的是**两个不同的网关**，key 也不同：

| 用途 | 网关 | 模型 |
| --- | --- | --- |
| 文本（改编/剧本/分镜） | `oneapi.ai-chat.host:8602` | `gpt-5.6-terra`（默认） / `DeepSeek-V4-Flash`（快） |
| 图像 | `oneapi-comate.baidu-int.com` | `gpt-image-2` |

图像曾试过 Nano Banana，`aspectRatio` 参数不生效，放弃了。

```
ONEAPI_BASE_URL=http://oneapi.ai-chat.host:8602
ONEAPI_API_KEY=sk-xxx
ARK_API_KEY=          # 火山方舟，Seedance 2.5 音视频联合生成
VOLC_ACCESS_KEY=      # 即梦图生视频（无声），改用 Seedance 后可留空
VOLC_SECRET_KEY=
VOLC_TTS_API_KEY=     # 火山 TTS，同上
```

**Seedance 走的是 Bearer，不是 SigV4。** 即梦在 `visual.volcengineapi.com`，用 AK/SK 签名；
Seedance 2.5 在方舟 `ark.cn-beijing.volces.com/api/v3`，只要
`Authorization: Bearer $ARK_API_KEY`。签名代码不能复用，别照着即梦那套改。

## 命令

```bash
npm run create -- --meta ../剧本agent/workspace/projects/xxx/export/meta.json --episodes 1 \
  --concurrency 10 --style "Photorealistic live-action film still of real human actors, ..."
npm run export -- --work "剑仙今天修空调-第1集"
```

`create` 参数：`--meta` / `--idea`（无剧本时直接给点子） / `--work` / `--episodes` /
`--style`（覆盖 `artStyle`，切真人/二次元用它） / `--restoryboard`（剧本留着只重拆分镜） /
`--fill-en`（给老作品补英文字段） / `--concurrency` / `--mock`。

`export` 参数：`--work` / `--target h3|seedance`（默认 h3）。

一集一个作品目录，目录名默认是 `<标题>-第N集`，所以 `--episodes` 换个数字就是下一集。

**`--mock` 一定配独立的 `--work`**，比如 `--work "剑仙-mock"`。mock 出的是 5331 字节纯白 PNG，
带 `.png.txt` 边车文件，但 skip-existing 逻辑分不出真假，会被后续真跑当成已完成图片直接跳过。
（唯一的破绽是耗时显示 `0s`。）

探针（单段验证，不跑全链路）：
`probe` / `probe:storyboard` / `probe:images` / `probe:video` / `probe:seedance` / `probe:compose`

`npm run produce` 是老的即梦全自动出片路径，现在不是主线。

## 出图是可断点续跑的

- 三个生成器都接 `imagesDir`，已存在的文件直接跳过
- `mapLimit` 容忍单张失败：失败的位置留 `null`，不拖垮整批，最后汇总报前 5 条错误
- 参考图并发 = `max(2, concurrency/2)`，参考图比分镜图重（要传多张 ref）

## 踩过的坑

**`emotion` 严格枚举炸掉整批。** LLM 写了 `tense`，`z.enum` 连续两次校验失败，
24 个镜头全废。现在 `Emotion` 用 `z.preprocess` + 别名表兜底（`tense/nervous/scared → fear` 等），
认不出的一律降级 `neutral`。

范围刻意收窄：**只有 emotion 放宽**。它是软提示，猜错了画面不塌。
`shotSize` / `cameraMove` 是结构字段，必须严格——猜错会拼出模型看不懂的运镜词。

**空台词行。** JSON 模板里示范了 `text: ""` 的形状，LLM 照抄，24 镜里 10 镜台词是空串。
`generateStoryboard` 现在过滤掉 `text.trim()` 为空的行。

**`musicDirection` 写成分场景配乐表。** 200 字的一张表，塞进 prompt 里是噪声。
试过按分号截断，但分号在不同作品里语义不同（一处是分场景，一处是音乐弧线），
截断会切错。最后把约束写回 adapt / script 的提示词里：只要一个统一基调。

**环境音关键词的假阳性。** 单字匹配 `车` 命中"旧车票"，给书店配了车流声；
单字 `雨` 命中"雨后的街道"，雨停了还在下。现在改成词组匹配
（`雨水|雨丝|下雨|雨点`、`车流|马路|街道|车辆`）并排除 `雨后|雨停|雨歇`。
这是权宜之计，正解是给 `Scene` 加 `ambience` 字段，别从动作文本里猜。

**参考图不转 JPEG，分镜图会全挂。** `shrinkRef` 原来只做 `sips -Z 1536`，而 `gpt-image-2`
输出本来就是 1536×1024，缩放是 no-op —— 实测缩前缩后字节数完全相同（2550313 == 2550313）。
2.5MB 的 PNG 原样上传，一个请求带场景图 + 3 张角色图 + 白画布接近 10MB，并发 10 时
24 张全部 `fetch failed`（跑了 1371s）。改成 JPEG quality 85 后 24/24 通过，244s。

## 已验证

- `怀表里的旧时光`：15 镜，全部图片 + `film.mp4`（走的是老的即梦路径，无声）
- `剑仙今天修空调-第1集`：改编 → 6 场景 24 镜分镜 → 10 张参考图（4 角色 + 6 场景），
  二次元画风
- `剑仙今天修空调-第1集-真人`：8 段 × 15s = 120s，35 镜。逐段拆分镜 65s，
  分镜图 35/35（561s，并发 6），`npm run export` 出 `01-xxx.txt` 到 `08-xxx.txt`。
  真人画风下角色脸型/发型/服装跨镜一致，四视图角色卡这套锚点对实拍风同样有效
- `npm run typecheck` 通过

## 未验证 / 已知问题

- **H3 的 prompt 还没实跑过。** 格式对着官方扩写规范逐条写的，但没上传验证过
  H3 的实际接受度，尤其是 `retention_analysis` 的关系标记和 `<Subject N>` 的绑定效果
- **Seedance provider 没实跑过**，`.env` 里没有 `ARK_API_KEY`
- **真人素材可能过不了 Seedance 的审核。** 官方要求参考图里的真实人脸需要 LAS 白名单，
  真人画风的角色卡属于这一类。上传前先拿一段试
- **画面里偶尔会出现墙面中文字（含乱码字形）**，`negativePrompt` 里已经有 `text`、`watermark`
  但压不住 —— 场景 location 写了"拆迁标语"这类内容时模型会照画。要么改 location 描述，
  要么重抽
- **`compose.ts:97` 的 `-map '[v]' -map '[a]'` 会丢掉 Seedance 自带的音轨。**
  那行是为即梦（无声视频 + 独立 TTS）写的，走 Seedance 时必须改
- 不做字幕。相关 ffmpeg / libass 逻辑一律不加

## 后续可加

- `Scene.ambience` 字段，取代从动作文本猜环境音
- Seedance `return_last_frame` 做场景间衔接
- 批量：`create` 外面套一层跑满全集
