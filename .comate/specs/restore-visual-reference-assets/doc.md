# 恢复首帧模式下的视觉参考图展示

## 需求场景与处理逻辑

当前《人间渡》`ep01` 控制台中，角色卡和场景卡文件已存在于当前集的 `media/images` 目录，`script.json` 也通过 `characters[].refImagePath`、`scenes[].refImagePath` 声明了这些素材。但由于每个镜段显式声明 `wan3Mode: "first_frame"`，`/api/segments` 当前只在未声明模式时回退展示全局角色卡和场景卡，因此前端没有返回任何 `参考素材` 数据。

需要修复接口和前端展示契约：

- `wan3ReferencePaths` 明确声明的素材继续作为 `reference_image` 返回，表示它们会进入万相 API 请求。
- `first_frame`、`I2VA` 等首帧相关模式下，已有的角色卡、场景卡仍返回给前端，但使用新的 `visual_reference` 角色，表示它们用于人工核对或首帧制作，不会与 `first_frame` 同时上传到万相 API。
- 页面新增或调整为“视觉参考”分组，展示 `visual_reference`，并使用准确的说明文案，避免用户认为这些图片会自动进入当前视频请求。
- 不改变 `/api/produce` 的模式校验和请求入参逻辑；当前任务只解决“图片参考看不到”，不把首帧模式悄悄改成参考图模式。

## 架构与技术方案

### 数据流

```text
script.json
  -> /api/segments
     -> globalRefs: characters/scenes 的 refImagePath basename
     -> allImages: 当前集 media/images 中实际存在的图片
     -> segments[].deps
        - first_frame / last_frame: 关键帧
        - reference_image: wan3ReferencePaths 明确入参
        - visual_reference: 首帧模式下可见但不进 API 的角色/场景卡
        - prop: 道具和构图参考
  -> 分集控制台
     -> 参考素材：仅 reference_image
     -> 视觉参考：visual_reference
     -> 首帧制作源素材：其他辅助素材
```

后端继续使用现有的 basename 解析和 `allImages.has(name)` 存在性判断，避免引入新的磁盘扫描路径或 URL 格式。前端继续复用现有 `ImageCard` 和 `/api/images/<work>/<episode>/<filename>` 静态代理。

### 角色定义

在 `src/app/api/segments/route.ts` 中扩展依赖角色联合类型（如果当前类型已在文件前部定义），加入：

```ts
'visual_reference'
```

首帧相关模式的回退逻辑改为：

```ts
const refs = declaredRefs.length > 0
  ? declaredRefs.map((name, i) => ({
      name,
      role: 'reference_image' as const,
      label: `图${i + 1}`,
      exists: allImages.has(name),
    }))
  : declaredMode === undefined
    ? globalRefs
        .filter((name) => allImages.has(name))
        .map((name) => ({ name, role: 'reference_image' as const, label: '', exists: true }))
    : [];

const visualRefs =
  declaredRefs.length === 0 && declaredMode !== undefined
    ? globalRefs
        .filter((name) => allImages.has(name))
        .map((name) => ({ name, role: 'visual_reference' as const, label: '', exists: true }))
    : [];
```

随后将 `visualRefs` 合并到 `deps`，并保证 `alreadyShown` 仍按文件名去重。若同一图片已被 `wan3ReferencePaths` 声明，则不应再次作为视觉参考出现。

更稳妥的实现是先生成 `refs`，再通过 `shownReferenceNames` 过滤全局素材：

```ts
const shownReferenceNames = new Set(refs.map((item) => item.name));
const visualRefs = declaredMode !== undefined
  ? globalRefs
      .filter((name) => !shownReferenceNames.has(name) && allImages.has(name))
      .map((name) => ({
        name,
        role: 'visual_reference' as const,
        label: '',
        exists: true,
      }))
  : [];
```

### 前端展示

在 `src/app/works/[workId]/[epId]/page.tsx` 中按依赖角色拆分数据：

- `reference_image` 继续进入现有“参考素材”分组。
- `visual_reference` 进入新的“视觉参考”分组。
- `prop` 和其他辅助角色继续进入现有“道具卡 / 构图参考”分组。

“视觉参考”分组说明必须明确：`首帧模式下用于核对和制作，不会随视频请求上传`。不要把 `visual_reference` 伪装成 `reference_image`，否则用户会误判万相请求实际携带了角色卡和场景卡。

如果页面当前通过 `role === 'reference_image'` 计算 `refs`、通过其他角色计算 `aux`，需要在不改变现有关键帧和道具分组的前提下加入 `visualRefs`。`ImageCard` 可直接复用，因为图片 URL 只依赖 `dep.name`。

## 受影响文件

- `/Users/zhangzhiyu/Desktop/创作/漫剧agent/src/app/api/segments/route.ts`
  - 修改镜段依赖构建逻辑。
  - 为显式首帧模式保留可见的全局角色/场景参考图。
  - 新增 `visual_reference` 依赖角色，并避免与 API 参考图重复。
- `/Users/zhangzhiyu/Desktop/创作/漫剧agent/src/app/works/[workId]/[epId]/page.tsx`
  - 修改镜段图片依赖分组逻辑。
  - 增加“视觉参考”展示区域和准确的提示文案。
- `/Users/zhangzhiyu/Desktop/创作/漫剧agent/.comate/specs/restore-visual-reference-assets/doc.md`
  - 当前需求规格。
- `/Users/zhangzhiyu/Desktop/创作/漫剧agent/.comate/specs/restore-visual-reference-assets/tasks.md`
  - 后续任务清单。
- `/Users/zhangzhiyu/Desktop/创作/漫剧agent/.comate/specs/restore-visual-reference-assets/summary.md`
  - 实施完成后生成。

不修改：

- `src/app/api/produce/route.ts`，因为本需求不改变视频生成模式或上传语义。
- 当前作品 `script.json`，因为已有 `refImagePath` 资产声明可被接口复用。
- 首帧图片生成和命名逻辑；缺失的 `S01-首帧.png` 至 `S07-首帧.png` 是另一条出片阻塞问题，不应在本需求中伪造为已存在。

## 边界条件与异常处理

- 只有 `allImages` 中实际存在的图片才返回为可展示依赖，避免页面出现无效图片卡。
- `wan3ReferencePaths` 非空时，声明素材优先作为 `reference_image`，不重复进入 `visual_reference`。
- 未声明 `wan3Mode` 的旧项目保持现有行为：全局角色卡和场景卡仍作为 `reference_image` 展示。
- 显式 `wan3Mode` 但没有任何可用全局参考图时，不渲染空的“视觉参考”分组。
- 不改变图片代理路由，仍由现有 `/api/images` 路由处理文件名和子目录 basename 回退。
- 不让 `visual_reference` 进入 `/api/produce` 的 `media` 入参，确保 first-frame 与 reference 模式互斥规则不被破坏。
- 若依赖类型使用显式联合类型，必须同步更新类型定义，避免 TypeScript 编译失败。

## 预期结果

打开《人间渡》`ep01` 控制台后：

- 角色卡和场景卡会出现在每个镜段的“视觉参考”区域，而不是继续消失。
- 页面会清楚区分“参考素材（API 入参）”与“视觉参考（仅核对/制作）”。
- 首帧文件仍缺失时，关键帧区域继续显示“文件不存在”，不会被错误地标记为已生成。
- 点击生成视频时，`first_frame` 请求行为不变，角色卡和场景卡不会被意外上传。
- `npm run typecheck` 或项目现有类型检查应通过。
