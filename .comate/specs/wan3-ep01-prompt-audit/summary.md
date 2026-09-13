# Wan3 EP01 Prompt 审计与修正总结

## 已完成

- 在 `src/core/pipeline/wan3-media.ts` 增加统一的 `buildWan3ReferencePlan`，集中处理参考图最终顺序、`@图片N` 编号平移、文件名标注和连续性尾帧说明。
- `/api/segments` 改为复用统一 Prompt 计划，并且只有在 `${segment}_last_actual.png` 真实存在时才将其作为第一张参考图；尾帧缺失时保持静态参考图编号，不再展示虚假的连续性引用。
- `/api/produce` 改为复用同一套 Prompt 编号规则，保证提交给 Wan3 的图片顺序与 Prompt token 一致。
- 修正图片 token 校验的索引计算：`@图片N` 只按图片媒体计数，不受 `reference_audio` 等非图片媒体影响。
- 保留严格连续性策略：声明继承上一镜但没有真实尾帧时，生产 dry-run 和正式生产均阻断，不退回设计首帧。

## EP01 回归结果

- `/api/segments?work=人间渡&episode=ep01`：S01-S07 的每个 `@图片N` 均能在同一镜头依赖列表中找到对应图片。
- 当前没有真实尾帧文件时，页面端 S02-S07 不再插入不存在的 `${previousSegment}_last_actual.png`。
- Wan3 dry-run：S01 正常生成请求编排；S02-S07 均明确阻断并提示缺少上一镜真实尾帧。
- `assetSummary.status` 保持 `ready`，静态图片 19 张，缺失引用 0，问题 0。
- 共享计划函数单独验证通过：加入真实尾帧后，S03 的参考顺序为“尾帧、闻笙、叶生、漏风书房”，Prompt token 同步为 `@图片1` 至 `@图片4`。

## 验证命令

- `npm run typecheck`：通过。
- `npm run build`：通过；仅有 Next.js 动态文件系统访问的既有 tracing 警告。
- 页面端 token 闭合检查：通过。
- `npm run lint`：未执行成功。仓库存在 lint 脚本，但当前 `node_modules` 和 `package.json` 中没有 `eslint` 可执行依赖，命令报 `eslint: command not found`。

## 当前外部前置条件

要继续生成 S02-S07，必须先得到并落盘对应的真实视频尾帧：S01 完成后生成 `media/videos/S01_last_actual.png`，再按链路依次生成后续镜头。当前代码不会用静态设计图伪造连续性尾帧。
