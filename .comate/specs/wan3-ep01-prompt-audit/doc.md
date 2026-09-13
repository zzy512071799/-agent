# Wan3 EP01 Prompt Audit

## 目标

审计并修正《人间渡》u1-ep01-02-叶生/ep01 的 S01-S07 分镜 Prompt，使每个镜头都能依据 `wan3-prompt-writer` 的规则被判定为可执行、可追踪、可预览。审计范围覆盖 Prompt 文本、真实图片资产、Wan3 API media 入参和网页预览，不把普通文件名文本误判为有效 `@图片` 引用。

## 需求场景与处理逻辑

### 需求一：逐镜核验模式和媒体完整性

对 S01-S07 读取 `wan3Mode`、`firstFramePath`、`lastFramePath`、`wan3FirstFrameFrom` 与 `wan3ReferencePaths`，检查：

- 首帧、尾帧或继承尾帧是否真实存在且能被当前工作目录解析；
- `reference` 模式的参考图是否全部存在；
- `first_frame` 模式是否只把首帧作为视频输入，不把仅用于核对的视觉参考伪装成 API 参考图；
- 首尾帧和全能参考是否满足接口互斥及 provider 的比例、时长约束；
- 资产缺失、命名与内容不一致时，镜头必须标记为不可出片或不完整，而不是伪造 ready 状态。

### 需求二：建立稳定的真实图片引用

每个 Prompt 中的 `@图片N` 必须与同镜头的媒体数组保持一一对应：

1. Prompt 中有稳定编号和明确文件/资源描述；
2. 编号 N 对应 API media 数组中的第 N 张图片；
3. 图片能通过本地附件、可访问 URL 或已上传资源标识真实传给 Wan3；
4. 网页中同一编号可以定位到对应的图片卡片并点击预览；
5. Prompt 描述、图片内容、文件名或资源 ID 三者一致；
6. 角色、场景、道具在实际被看见、动作发生、被特写或承担约束的位置内联引用，而不是只在末尾附加清单。

对无法满足上述条件的引用，保留明确的缺失/阻断状态，禁止生成装饰性 `@图片`。

### 需求三：修正动作和对白时序

每镜采用可执行的连续动作链描述：承接状态、触发动作、方向和轨迹、接触或受力、位移、角色反应、环境变化以及最终停留状态。对白必须写在动作发生的节点，明确角色开口、口型、发声时机、情绪/语速和台词内容；同一台词不得只在末尾声音总结中重复表达。

未被用户要求时，不保留无助于执行的“第几秒到第几秒”硬编码拆分。时长可继续由镜头字段控制，Prompt 以动作因果和镜头节奏为主。

### 需求四：让网页引用可交互核对

检查并必要时修改 `/api/segments` 和分镜详情页，使 Prompt 中的 `@图片N` 能与依赖图片建立可追踪关系。图片卡片必须展示真实预览地址、存在性和问题状态；点击后预览的图片必须与 Prompt 编号及 Wan3 上传顺序一致。若当前 `<pre>` 纯文本展示无法完成绑定，应采用最小范围的 Prompt 分段渲染或引用元数据映射，不改变无关页面布局。

## 架构与技术方案

### 数据源

实际 Prompt 和镜头声明以以下文件为准：

- `/Users/zhangzhiyu/Desktop/创作/漫剧agent/storage/works/人间渡/episodes/u1-ep01-02-叶生/ep01/script.json`
- 同目录的 `分镜表.md` 作为资产意图和缺失记录的辅助依据。

### 代码链路

```text
script.json
  -> Shot schema parse
  -> /api/segments: prompt + dependency metadata + preview URL
  -> 分镜详情页: Prompt 引用与 ImageCard
  -> /api/produce: collectReferencePaths + media ordering
  -> Wan3 provider: local file / URL -> media input
```

方案优先复用现有 `Shot` 字段、`shotReferenceImages`、`collectReferencePaths`、`ImageCard` 和图片服务路由。引用编号应由同一份已解析的参考媒体列表派生，避免 Prompt、API 和前端分别按文件名猜测。

本次采用统一的 `reference`（全能参考）策略：S01-S07 原则上全部改为 `wan3Mode: "reference"`，不再把角色/场景/道具放在仅供核对的 `visual_reference` 中。每镜参考图按相关性控制在 Wan3 的 10 张上限以内，优先顺序为：

1. 前一镜已生成的真实尾帧（用于连续镜头开场状态）；
2. 当前镜头实际出场人物的角色图；
3. 当前镜头场景图；
4. 当前动作中被拿取、碰撞、特写或承担关键约束的道具图；
5. 仅在确实影响构图时加入构图参考。

对于第一镜没有前置尾帧时，从当前镜头相关角色、场景和道具开始。对于后续镜头，前一镜的真实尾帧必须是可用的本地输出或可访问资源；没有真实尾帧时阻断衔接，不退回成伪造的首帧引用。`wan3FirstFrameFrom` 可继续作为来源声明，但在 `reference` 模式下应被解释为“把来源镜头的真实尾帧加入下一镜参考图列表”，并保证它在媒体数组和 Prompt 中拥有稳定编号。

全能参考模式下不再同时传 `first_frame`/`last_frame`，以遵守 provider 的互斥约束。对于显式 `wan3ReferencePaths`，保持声明顺序；对于自动加入的连续尾帧，放在参考列表第一位，并在 Prompt 中明确该图锁定下一镜开场构图和动作承接状态。

### 预计接口契约

参考依赖应至少能够表达：

```ts
{
  index: number;
  token: string; // @图片1
  name: string;
  path: string;
  role: 'first_frame' | 'last_frame' | 'reference_image' | 'visual_reference' | 'prop';
  exists: boolean;
  previewUrl?: string;
  uploadable: boolean;
  issue?: string;
}
```

实际类型应优先适配现有接口和组件，只有在现有结构无法表达编号绑定时才增加字段。

## 受影响文件

以下文件是审计和可能修改的边界，实施前需再次读取当前内容和行号：

- `/Users/zhangzhiyu/Desktop/创作/漫剧agent/storage/works/人间渡/episodes/u1-ep01-02-叶生/ep01/script.json`：修正 S01-S07 的 Prompt、参考图声明、具体结束状态和冗余对白/秒级拆分；必要时同步真实资产路径。
- `/Users/zhangzhiyu/Desktop/创作/漫剧agent/storage/works/人间渡/episodes/u1-ep01-02-叶生/ep01/分镜表.md`：仅在 Prompt 所需资产意图与分镜表不一致时同步记录，不覆盖原图或虚构缺失资产。
- `/Users/zhangzhiyu/Desktop/创作/漫剧agent/src/core/schema.ts`：确认并必要时补充引用元数据的 schema，保证 `Shot.parse()` 不丢字段。
- `/Users/zhangzhiyu/Desktop/创作/漫剧agent/src/app/api/segments/route.ts`：从统一参考媒体列表生成编号、存在性、预览地址和角色/场景/道具依赖。
- `/Users/zhangzhiyu/Desktop/创作/漫剧agent/src/app/api/produce/route.ts`：确保同一列表用于校验和 Wan3 `media` 顺序，并阻断缺失或 mismatch 资源。
- `/Users/zhangzhiyu/Desktop/创作/漫剧agent/src/app/works/[workId]/[epId]/page.tsx`：将 Prompt 引用与对应 ImageCard/预览地址建立交互关联。
- `/Users/zhangzhiyu/Desktop/创作/漫剧agent/src/core/providers/wan3.ts`：仅在审计发现现有本地文件、URL 或比例契约仍不一致时修改。
- 相关测试文件：为引用顺序、缺失资产、Prompt 渲染和 produce 阻断补充聚焦测试；测试文件位置以当前仓库既有测试约定为准。

## 实现细节

### 参考图编号

禁止继续用仅匹配文件名 stem 的方式临时插入引用。应先得到去重且有序的媒体依赖列表，再使用同一索引：

```ts
const refs = buildShotMediaRefs(shot, script, workDir);
const token = `@图片${ref.index}`;
```

Prompt 中应在对象实际发挥作用的位置写成类似：

```text
@图片1（闻笙-正面.png）对应的闻笙抬手压住铜铃；
他随后拿起 @图片2（铃.png）中的铜铃，铃面保持暗沉无反光。
```

如果资源不存在或内容复核为 mismatch，不能生成“有效引用”并继续提交；应在接口和页面显示具体问题。

### 动作与对白

每个镜头的 Prompt 应保留一个清晰动作链，并把台词嵌入发声节点，例如：

```text
叶生推门进入堂屋，脚步在门槛处停住；
@图片1（叶生.png）对应的叶生抬头看向供桌，喉结滚动后张口，声音发虚地说：「你……这是怎么了？」
他说完保持抬头和半迈步的结束姿势。
```

声音章节只保留未在动作节点表达的环境音、音乐和必要的总体混音约束，不能重复同一对白。

### 结束状态

将“按本镜头最后一个动作停住”替换成镜头特有的可观察状态，例如角色站位、手部位置、道具状态、视线方向、光线变化和下一镜承接条件。S05 的继承关系必须在 S04 实际尾帧可用后才允许运行，否则应显示阻断原因。

## 边界条件与异常处理

- 资产不存在：`exists=false`，接口返回 `incomplete`，produce 不创建 Wan3 任务。
- 图片命名与内容不一致：沿用 `refImageReview.status = "mismatch"` 语义，禁止上传并显示复核说明。
- `@图片N` 超出媒体数组范围、重复编号或顺序不一致：测试失败并阻断出片。
- 只在 Prompt 中出现文件名、但没有真实可传媒体：视为无效引用，不得渲染成可点击假链接。
- 首帧模式：首帧属于视频输入；角色/场景/道具只有在明确加入参考媒体且 provider 支持时才属于 API reference_image，否则标记为 visual_reference。
- 全能参考模式：所有 `@图片N` 必须严格对应 `wan3ReferencePaths` 顺序，缺一不可。
- S05 前置镜头尾帧不存在：保留 `wan3FirstFrameFrom`，但在状态中明确“等待 S04 尾帧”，不伪造可用首帧。
- provider 要求的比例、时长或媒体互斥约束失败：沿用现有错误处理并返回可定位错误，不降低校验标准。
- OneAPI 或图片生成服务失败：不覆盖原图，不把失败资产标记为 ready；允许后续重试后重新审计。

## 数据流路径

```text
镜头声明和人工 Prompt
  -> schema 解析
  -> 统一构造有序媒体依赖
  -> 资产存在性/内容复核
  -> API:
       prompt 中 @图片N
       media[N-1] 为同一图片
  -> 页面:
       @图片N -> 同 index ImageCard -> 同一 previewUrl
  -> produce:
       缺失或 mismatch 时阻断
       合格时提交 Wan3
```

## 预期结果

- S01-S07 均有逐镜审计结果，明确模式、帧资产、参考媒体、预览、动作、对白和结束状态。
- 所有保留的 `@图片N` 都能追溯到真实图片，并与 API media 和网页预览一一对应。
- 缺失的妇人角色图、漏风书房图、首帧和错误命名图片不会被伪装为合格资源。
- Prompt 中对白只在实际动作/发声节点承担时序信息，不在末尾重复。
- 无必要的硬编码秒级拆分被移除，镜头动作保持连续可执行。
- `assetSummary` 只有在所需资源和引用映射完整时才为 `ready`。
- 通过接口、组件和自动化测试验证后，输出审计/实施总结。
