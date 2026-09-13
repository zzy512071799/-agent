# 实施总结

## 完成内容

已修复《人间渡》`ep01` 控制台无法看到已有角色卡、场景卡的问题。

后端 `/api/segments` 现在区分两类素材：

- `reference_image`：由 `wan3ReferencePaths` 明确声明，会作为万相 API 入参。
- `visual_reference`：在显式 `wan3Mode` 的镜段中，从已存在的全局角色卡和场景卡生成，仅用于控制台核对和首帧制作，不会进入视频 API 请求。

已加入文件名去重逻辑：同一文件已经作为 `reference_image` 返回时，不会再次作为 `visual_reference` 展示。

前端分集控制台新增“视觉参考”分组，并明确标注：首帧模式下这些图片用于核对和制作，不随视频请求上传。现有“关键帧”“参考素材”“道具卡 / 构图参考”“首帧制作源素材”分组保持原有语义。

同时补齐了前端依赖角色标签映射中的 `visual_reference` 类型。

## 修改文件

- `src/app/api/segments/route.ts`
- `src/app/works/[workId]/[epId]/page.tsx`

## 验证结果

- `npm run typecheck`：通过。
- 请求 `GET /api/segments?work=人间渡&episode=ep01`：通过。
- 每个镜段均返回以下已存在的视觉参考图：
  - `闻笙-正面.png`
  - `阿离-正面.png`
  - `旧药箱.png`
  - `叶生.png`
  - `状元桥街市.png`
  - `旧宅堂屋.png`
- `S01-首帧.png` 至 `S07-首帧.png` 仍返回 `exists: false`，没有把缺失首帧误标为已生成。
- 当前接口没有声明 `wan3ReferencePaths`，因此本集不会错误地产生 `reference_image` API 入参；角色卡和场景卡仅作为 `visual_reference` 展示。

## 未包含的独立问题

当前 7 张首帧文件实际仍未落盘。此次修复只恢复已有角色卡、场景卡的可见性，没有伪造首帧文件，也没有改变 `first_frame` 生成链路。要恢复视频生成，仍需生成或补齐与 `script.json` 完全同名的 `S01-首帧.png` 至 `S07-首帧.png`。
