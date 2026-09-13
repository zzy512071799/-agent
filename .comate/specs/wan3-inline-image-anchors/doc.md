# Wan3 情景内联图片引用修正

## 需求场景与处理逻辑

当前 Wan3 Prompt 编译器在原始 Prompt 没有 `@图片N` 时，会把所有真实参考图统一追加到 Prompt 末尾。这样虽然保证了编号闭合，但图片引用没有贴合剧情节点：角色第一次出现、场景承担空间约束、道具被拿起或被特写时，Prompt 中对应位置没有 `@图片`。

本需求修正为：

1. 保持最终 Wan3 media 数组顺序不变。
2. 保持 `@图片N` 与媒体数组第 N 张图片、网页依赖卡片一一对应。
3. 对每张真实参考图，根据当前 Prompt 中与该图片对应的情景锚点，把 `@图片N（文件名）` 插入到最相关的动作/画面句中。
4. 同一图片若在多个动作节点持续发挥作用，可以在首次出现处内联一次，并在后续关键动作处重复引用。
5. 找不到可信语义锚点时，才追加到末尾，并明确标记为未定位参考约束，不能猜测插入到无关句子。
6. 连续尾帧仍只能在真实文件存在时进入最终参考数组；不存在时页面和生产保持一致地不前插尾帧。

## 架构与技术方案

将现有 `buildWan3ReferencePlan` 扩展为“编号规范化 + 情景锚点内联”的共享编译器，`/api/segments` 和 `/api/produce` 都只调用这一处逻辑。

建议新增内部类型：

```ts
export type Wan3ReferenceAnchor = {
  path: string;
  needles: string[];
};

export type Wan3ReferencePlan = {
  refs: string[];
  prompt: string;
  unresolved: string[];
};
```

编译流程：

```ts
const finalRefs = [...refs];
const normalizedPrompt = normalizeExistingImageTokens(prompt, finalRefs, continuityPath);
const inlinePrompt = inlineReferenceTokens(normalizedPrompt, finalRefs, anchorMap);
const output = appendUnresolvedConstraints(inlinePrompt, unresolved);
```

锚点匹配必须是保守的：

- 优先匹配完整文件名去扩展名，例如“闻笙-正面”“漏风书房”“旧药箱”。
- 再匹配明确的角色、场景、道具名称，例如“闻笙”“叶生”“妇人”“铃”“药箱”“书房”。
- 角色动作引用应插入角色第一次进入画面或发生关键动作的句子，例如“闻笙背着旧药箱站定”中的闻笙引用和药箱引用。
- 道具引用应插入道具被拿起、背起、打开、敲击、抽出、特写或改变状态的句子。
- 场景引用应插入建立空间关系或镜头明确依赖该场景结构的句子。
- 不允许仅因文件名包含通用词就插入到不相关节点；匹配不确定时保留到未定位约束。

对于当前《人间渡》EP01，应使引用靠近这些语义节点：

- S01：闻笙出场并背着旧药箱时引用闻笙图和药箱图；阿离从药箱后探头时引用阿离图；街市建立空间时引用街市场景；叶生状元队伍进入时引用叶生图。
- S02：闻笙、叶生、阿离、旧药箱和状元桥街市引用分别靠近对应人物/道具/环境节点；若本镜完全承接上一镜，也允许在承接句中重复必要角色引用。
- S03：真实上一镜尾帧若存在，尾帧引用放在开场承接句；闻笙和叶生引用放在对应人物出现/观察动作；漏风书房引用放在书房空间建立句。
- S04/S05：叶生、妇人和旧宅堂屋引用放在对应人物动作、妇人反应和堂屋空间句；关键接触动作处可重复角色引用。
- S06：叶生引用放在出门和无影状态句；闻笙引用放在墙影中出现和观察棺材句。
- S07：叶生、闻笙和铃引用放在回头动作、闻笙抽铃和铃的静默状态句。

## 影响文件

- `/Users/zhangzhiyu/Desktop/创作/漫剧agent/src/core/pipeline/wan3-media.ts`
  - 修改 `Wan3ReferencePlan`。
  - 修改 `buildWan3ReferencePlan`，增加情景锚点内联和未定位引用记录。
  - 保持 `extractWan3ImageTokens`、`validateWan3ImageTokens` 的现有校验职责。
- `/Users/zhangzhiyu/Desktop/创作/漫剧agent/src/app/api/segments/route.ts`
  - 继续调用共享计划函数。
  - 将镜头中角色、场景、道具的显式元数据转换为锚点输入，或使用共享函数提供的文件名/对象名锚点。
  - 返回的 `deps` 必须继续使用最终 refs 顺序。
- `/Users/zhangzhiyu/Desktop/创作/漫剧agent/src/app/api/produce/route.ts`
  - 继续调用共享计划函数。
  - 实际提交的 Prompt 必须与页面端使用同样的锚点和最终 refs 顺序。
- `/Users/zhangzhiyu/Desktop/创作/漫剧agent/storage/works/人间渡/episodes/u1-ep01-02-叶生/ep01/script.json`
  - 仅在共享编译器无法从现有文本和元数据可靠识别时，补充必要的镜头级引用锚点元数据；不改变剧情、台词、动作和媒体顺序。
- `/Users/zhangzhiyu/Desktop/创作/漫剧agent/.comate/specs/wan3-inline-image-anchors/tasks.md`
  - 记录实施和验证步骤。
- `/Users/zhangzhiyu/Desktop/创作/漫剧agent/.comate/specs/wan3-inline-image-anchors/summary.md`
  - 记录最终结果和验证限制。

## 边界条件与异常处理

- 真实尾帧缺失时，不能生成或展示 `@图片1（前一镜真实尾帧）`。
- 参考图数量仍不得超过 Wan3 的 10 张限制。
- 已有 `@图片N` 必须先按最终 refs 顺序规范化，不能重复平移。
- 同一图片重复引用合法，不应被当作编号冲突。
- 语义锚点匹配失败不能伪造具体动作位置，应放入末尾的“未定位参考约束”并记录 `unresolved`。
- 文件名、图片内容和 Prompt 描述必须保持一致；mismatch 图片不能作为可上传引用。
- 不能把参考图片 token 插入对白台词内部，除非图片本身就是该台词动作直接作用的对象。
- 不改变用户已有对白文本，不新增字幕，不新增旁白。

## 数据流

```text
script.json shots[].wan3Prompt + wan3ReferencePaths
  -> 读取镜头角色/场景/道具元数据
  -> 确定真实连续尾帧（可用才加入）
  -> 生成最终 refs 顺序
  -> 共享编译器规范化已有 token
  -> 按情景锚点内联 @图片N
  -> 追加无法定位的少量约束
  -> segments 返回 prompt + deps + previewUrl
  -> produce 使用同一 prompt + media 顺序提交 Wan3
  -> 前端按 token 查找同一 deps 卡片并打开同一预览图
```

## 预期结果

- `@图片` 不再默认全部集中在 Prompt 末尾。
- S01-S07 中角色、场景、道具引用出现在对应画面和动作节点附近。
- 页面展示 Prompt 与实际发送给 Wan3 的 Prompt 在 token 编号和图片对象上完全一致。
- 无真实尾帧时，页面不显示虚假连续性引用，生产请求明确阻断。
- 现有静态资产数量、`assetSummary.status`、媒体数量限制和网页点击预览行为不回归。