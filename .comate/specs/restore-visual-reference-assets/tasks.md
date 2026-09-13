# 恢复首帧模式下的视觉参考图展示任务计划

- [x] Task 1: 扩展镜段依赖接口以返回视觉参考图
    - 1.1: 检查 `src/app/api/segments/route.ts` 中依赖角色类型和 `deps` 构建逻辑
    - 1.2: 增加 `visual_reference` 角色类型，保持 `reference_image` 的 API 入参语义不变
    - 1.3: 在显式 `wan3Mode` 且未声明 `wan3ReferencePaths` 时，从已存在的全局角色卡和场景卡生成视觉参考依赖
    - 1.4: 对已作为 `reference_image` 返回的文件名去重，避免同一图片重复展示
    - 1.5: 保持真实存在性判断和未声明 `wan3Mode` 时的旧项目回退行为

- [x] Task 2: 在分集控制台展示视觉参考图
    - 2.1: 检查 `src/app/works/[workId]/[epId]/page.tsx` 当前对 `reference_image`、`prop` 和其他依赖的分组逻辑
    - 2.2: 将 `visual_reference` 从普通辅助素材中单独分组
    - 2.3: 增加“视觉参考”区域并复用现有 `ImageCard` 图片加载路径
    - 2.4: 添加明确说明，标注首帧模式下素材仅用于核对和制作，不会随视频请求上传
    - 2.5: 确保空分组不渲染，且不影响关键帧、API 参考素材和道具卡区域

- [x] Task 3: 执行类型与行为回归检查
    - 3.1: 对比《人间渡》`ep01` 的 `script.json`、实际图片目录和 `/api/segments` 依赖结果
    - 3.2: 验证已有角色卡、场景卡会出现在 `visual_reference` 中
    - 3.3: 验证缺失的 `S01-首帧.png` 至 `S07-首帧.png` 仍准确显示为缺失，不被伪装成已生成
    - 3.4: 验证显式 `wan3ReferencePaths` 的素材仍保持 `reference_image`，不会重复进入视觉参考
    - 3.5: 运行项目现有 TypeScript 类型检查和可用测试，确认生成接口行为未被改变

- [x] Task 4: 记录实施结果
    - 4.1: 汇总修改文件、接口行为和页面展示变化
    - 4.2: 记录验证命令及结果，包括仍需单独补齐的首帧文件问题
    - 4.3: 将结果写入 `.comate/specs/restore-visual-reference-assets/summary.md`
