# Wan3 三镜头能力测试阶段总结

## 已完成

- 创建 EP02 独立探针配置 `probes.json`，包含 P01、P02、P03。
- 生成并复制两张动作首帧图：
  - `media/images/分镜/叶生-棺前惊恐站姿.png`
  - `media/images/分镜/叶生-跪姿扶棺.png`
- P01 使用真实“棺前惊恐站姿”图，验证表情与后退动作。
- P02 使用闻笙正面角色图，验证单句对白“你早死了。”。
- P03 使用真实“跪姿扶棺”图，验证从手指开始的消散动作。
- 新增只读接口 `src/app/api/probes/route.ts`，读取探针配置并返回：Prompt、时长、参考图、图片预览地址和 token 校验结果。
- 正式 EP02 链仍保持 `C01-C16`，探针不会进入正式镜头链。

## 验证结果

- `/api/probes?work=人间渡&episode=ep02` 返回 P01、P02、P03。
- 三个探针的图片预览地址均生成成功。
- 三个探针的 `@图片N` 引用校验均为有效。
- `production` 为 `probe-only`。
- `requiresUserConfirmationForGeneration` 为 `true`。
- `npm run typecheck` 通过。
- `npm run build` 通过，退出码为 `0`。

## 当前未执行

- 未调用 Wan3 API。
- 未生成 P01、P02、P03 视频。
- 未产生视频生成费用。
- 未覆盖正式 EP02 视频或 `C01-C16` 配置。

## 下一步

测试配置和预览接口已经就绪。正式生成仍需用户明确确认；确认后按 P01 → P02 → P03 顺序生成，每个视频完成后先检查动作、表情、口型、声音和尾帧，再决定是否推广到完整 EP02。

构建输出仍有既有 Next.js 动态文件系统 tracing warning 和本机 npm 配置 warning，不影响构建结果。
