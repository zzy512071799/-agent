# Wan3 Prompt、参考图模式与资产完成度实施总结

## 已完成

- 固化 `Shot` 的 Wan3 字段：模式、提示词、结束状态、首帧/尾帧、参考图、音频参考和首帧继承字段均由 Zod 保留。
- 更新 `buildWan3Prompt()`，自动生成提示词按以下顺序输出：
  1. 首帧或首帧/尾帧锁定；
  2. 有序参考图约束；
  3. 单镜头与对白/无台词；
  4. 镜头参数；
  5. 连续动作内容；
  6. 人物约束；
  7. 明确结束状态；
  8. 音效。
- 自动 Prompt 默认不再硬拆“第几秒到第几秒”；ep01 已有人工 `wan3Prompt` 也已同步迁移，保留原动作、对白和音效内容，同时补充锁定约束与结束状态。
- 为《人间渡》ep01 的 S01-S07 补充明确结束状态，保留对白、战斗/动作因果链、镜头参数和音效。
- 参考图模式已保持真实上传顺序：S03 为 `闻笙-正面.png`、`叶生.png`、`漏风书房.png`。
- 首帧模式不会上传额外参考图；S05 保留 `wan3FirstFrameFrom: "S04"`，只有上一段产生真实尾帧时才继承。
- Wan3 编排器会过滤 `refImageReview.status === "mismatch"` 的图片，避免错误资产进入参考图请求。
- `/api/segments` 已返回镜段模式、依赖角色、文件存在性、参考图顺序、命名/内容问题和整体素材状态。
- Prompt 编译器现在把 `@图片` 锚点内联到人物、场景、道具第一次进入动作正文的位置；对白进入连续动作后的“对白时序”事件，明确按角色出场顺序与口型同步，不再只作为末尾声音总结。
- ep01 的 S03 已将闻笙、叶生、漏风书房的 `@图片` 放入实际画面内容；有台词的 S01、S02、S04、S05、S07 已补充动作中的同步台词。

## 当前镜段模式

| 镜段 | 模式 | 参考图/帧策略 |
|---|---|---|
| S01 | `first_frame` | 使用设计首帧，突出叶生无影 |
| S02 | `first_frame` | 使用设计首帧，承载“高中”执念视觉 |
| S03 | `reference` | 闻笙、叶生、漏风书房，按声明顺序上传 |
| S04 | `first_frame` | 使用设计首帧，锁定妇人摔碗后的空间关系 |
| S05 | `first_frame` | 继承 S04 的真实尾帧，未伪造尾帧路径 |
| S06 | `first_frame` | 使用设计首帧，锁定棺材、棺中尸身和叶生无影 |
| S07 | `first_frame` | 使用设计首帧，锁定不响的铃和无影收尾 |

## 校验结果

- `npm run typecheck`：通过。
- `script.json`：可解析，7 个镜段均有 `wan3EndState`。
- 图片格式：现有 17 张图片均可解析，未发现格式损坏。
- `/api/segments?work=人间渡&episode=ep01`：回归通过。
  - S03 返回 `reference`，三张参考图顺序正确；前两张存在，漏风书房缺失。
  - 首帧镜段没有额外 `reference_image` 依赖。
  - S05 返回 `inheritFrom: S04`。
  - 整体状态准确返回 `incomplete`。

## 未完成与阻塞

- `阿离-正面.png` 内容与命名不一致，已标记为 `mismatch`，不能作为正面参考图使用。
- `妇人-正面.png` 尚未生成。
- `漏风书房.png` 尚未生成，因此 S03 的第三张参考图不可用。
- S01、S02、S04、S05、S06、S07 的设计首帧文件缺失。
- OneAPI 图片上游此前连续返回 HTTP 502，当前没有生成成功结果；原错误资产未覆盖，已有备份和失败记录仍保留。
- 因上述资产缺失，整体不能标记为 `ready`，Task 5 和 Task 7 保持未完成。

## 相关文件

- `src/core/schema.ts`
- `src/core/pipeline/storyboard.ts`
- `src/app/api/produce/route.ts`
- `src/app/api/segments/route.ts`
- `storage/works/人间渡/episodes/u1-ep01-02-叶生/ep01/script.json`
- `.comate/specs/dialogue-battle-and-asset-readiness/tasks.md`
