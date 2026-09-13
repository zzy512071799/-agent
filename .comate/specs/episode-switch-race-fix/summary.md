# 分集切换竞态修复总结

## 根因

EP01 与 EP02 的服务端数据本身正确：EP01 返回 `S01-S07`，EP02 返回 `S01-S05`。问题在分集控制台的客户端加载 effect：切换分集后，旧的 EP01 请求没有取消，也没有响应归属校验；旧响应晚到时可能通过 `setChains` 覆盖当前 EP02 状态。

此外，切换分集后新请求完成前，旧的镜头链仍保留在页面中，会让用户暂时看到上一集的 `S01-S07`。

## 修改内容

修改文件：

- `src/app/works/[workId]/[epId]/page.tsx`
  - 为 `/api/segments` 和 `/api/works` 请求增加 `AbortController`。
  - 增加 `active` 请求归属标记，旧 effect 的响应不能更新当前页面。
  - 将请求取消产生的 `AbortError` 视为正常流程。
  - 分集切换开始时清空旧的 chains、selected、assetCatalog、assetSummary、epDir 和 loadErr 状态。
  - 保留原有视频任务轮询清理逻辑。
  - 保持镜头渲染、Prompt、资产预览、生成控制和分集导航逻辑不变。

## 验证结果

- EP01 `script.json`：`S01 -> S02 -> S03 -> S04 -> S05 -> S06 -> S07`。
- EP02 `script.json`：`S01 -> S02 -> S03 -> S04 -> S05`。
- `/api/segments?work=人间渡&episode=ep01`：返回 7 个镜段 `S01-S07`。
- `/api/segments?work=人间渡&episode=ep02`：返回 5 个镜段 `S01-S05`。
- `/works/人间渡/ep02`：HTTP 200。
- `npm run typecheck`：通过。
- `npm run build`：通过，退出码为 `0`。

## 结论

分集控制台现在只允许当前分集的请求更新页面，并在切换时移除上一集的旧镜头状态。访问或切换到 `/works/人间渡/ep02` 后，页面应显示 EP02 的 `S01-S05`，不会再被 EP01 的 `S01-S07` 覆盖。

构建输出仍有 5 条既有 Next.js 动态文件系统 tracing warning，以及本机 npm 配置 warning；未发现编译、类型或构建失败。
