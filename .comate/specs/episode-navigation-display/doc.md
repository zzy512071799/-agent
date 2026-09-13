# 分集导航展示修复

## 需求场景与处理逻辑

《人间渡》EP02 的 `script.json`、`/api/works` 和 `/api/segments?episode=ep02` 均正常，但页面入口无法展示或进入 EP02：

- 首页作品入口固定跳转到 `ep01`。
- 分集页虽然请求了 `/api/works` 并读取当前集标题，但没有保存或渲染完整 `episodes` 列表。

修复目标：

1. 首页展示作品可用的分集入口，至少包含 EP01 和 EP02。
2. 点击 EP02 可进入 `/works/{workId}/ep02`。
3. 分集详情页提供同作品的分集切换入口，当前集有明确选中状态。
4. 不改变 `/api/works`、`/api/segments`、Wan3 生产逻辑和镜头数据。
5. 保持已有作品和只有 EP01 的项目兼容。

## 架构与技术方案

优先复用现有 `/api/works` 返回的 `episodes: Array<{epId,title}>`，不新增接口。

首页：

- 读取现有作品列表中的 `episodes`。
- 当作品有多个分集时，在作品入口区域渲染分集链接。
- 若分集列表为空，保留现有 `ep01` 回退入口。
- 链接使用现有 `encodeURIComponent(workId)` 和 `ep.epId`。

分集页：

- 在现有 `load()` 读取 `/api/works` 的逻辑中，将当前作品的 `episodes` 保存到 state。
- 在页面标题/工具栏附近增加分集导航。
- 每个导航项链接到同作品对应的 `epId`；当前 `epId` 使用选中样式。
- 不通过 `hasVideo` 过滤分集，未生成视频的 EP02 也必须可见。

## 影响文件

- `/Users/zhangzhiyu/Desktop/创作/漫剧agent/src/app/page.tsx`
  - 修改作品入口渲染，使用 API 返回的 episodes 生成链接。
  - 保留空分集列表时的 ep01 回退行为。
- `/Users/zhangzhiyu/Desktop/创作/漫剧agent/src/app/works/[workId]/[epId]/page.tsx`
  - 增加 episodes state。
  - 在现有控制台头部增加分集导航。
  - 不修改镜头数据和生产控制逻辑。

## 边界条件

- 作品不存在或接口失败时，沿用当前错误展示。
- `episodes` 缺失、非数组或为空时，首页仍显示原有 ep01 入口。
- 分集标题缺失时显示 `epId`。
- `workId` 和 `epId` 必须进行 URL 编码。
- 当前集链接不可因没有 mp4、尾帧或资产而隐藏。
- 不引入新的后端接口或持久化数据。

## 数据流

```text
/api/works
  -> 首页读取 work.episodes -> 渲染 EP01/EP02 链接
  -> 分集页读取 work.episodes -> 渲染分集切换导航
  -> 点击 EP02
  -> /api/segments?work=人间渡&episode=ep02
  -> 展示 S01-S05
```

## 预期结果

- 从首页可以直接看到并进入《人间渡》第 2 集《可曾活过》。
- 直接打开 `/works/人间渡/ep02` 时，页面显示 EP02 标题和 S01-S05 镜头。
- 分集页可以在 EP01/EP02 之间切换。
- `npm run typecheck` 和 `npm run build` 通过。