# 分集导航展示修复总结

## 完成内容

- 首页不再固定只提供 `ep01` 入口，改为读取作品的 `episodes` 列表并展示分集链接。
- 分集控制台保存当前作品的完整分集列表，在顶部提供 EP01、EP02 等切换入口。
- 当前分集使用选中状态，其他分集链接使用统一的作品/分集路由。
- 无分集数据时保留原有 `ep01` 回退入口。
- EP02 不依赖是否已有视频，因此不会因尚未出片而从入口列表中消失。

## 修改文件

- `src/core/work.ts`
  - 扩展 `listWorks()` 返回值，读取 `project.json` 中的 episodes 并转换为 `epNN` 与标题。
- `src/app/page.tsx`
  - 根据作品的 episodes 列表渲染首页分集入口。
- `src/app/works/[workId]/[epId]/page.tsx`
  - 增加 episodes 状态。
  - 在控制台顶部渲染分集导航并标记当前分集。

## 验证结果

- `/api/works` 返回《人间渡》的 EP01 至 EP24，包含：
  - `ep01 · 衣锦还乡`
  - `ep02 · 可曾活过`
- 首页 HTTP 状态为 `200`，返回内容包含 `ep01`、`ep02` 及对应标题。
- `/works/人间渡/ep01` HTTP 状态为 `200`。
- `/works/人间渡/ep02` HTTP 状态为 `200`。
- `/api/segments?work=人间渡&episode=ep02` 返回 `S01`、`S02`、`S03`、`S04`、`S05`，资产状态为 `ready`。
- `npm run typecheck` 通过。
- `npm run build` 通过，退出码为 `0`；输出 5 条既有 Next.js 动态文件系统 tracing warning，不影响构建结果。

## 结论

EP02 已接入页面分集入口，并可从首页进入；在 EP01 与 EP02 页面之间可通过顶部导航切换。镜头数据由客户端加载，页面初始 HTML 不包含 S01-S05 文本，但对应 segments 接口返回完整五镜配置，控制台前端会按该数据渲染镜头列表。
