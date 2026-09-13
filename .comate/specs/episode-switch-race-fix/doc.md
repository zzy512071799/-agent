# 分集切换竞态修复规格

## 需求场景与处理逻辑

用户从《人间渡》EP01 切换到 EP02 时，页面偶发继续显示 EP01 的 `S01-S07`。服务端接口实际已经按 `epId` 返回正确数据：EP01 为 `S01-S07`，EP02 为 `S01-S05`。问题发生在前端异步请求竞态：旧的 EP01 `/api/segments` 请求在 EP02 请求之后返回时，仍然执行 `setChains`，覆盖了当前 EP02 的页面状态。

修复后的处理逻辑：

1. `workId` 或 `epId` 变化时，立即清空上一集的镜头链、选中镜头、资产目录和加载错误状态。
2. 为当前 `useEffect` 创建 `AbortController`，组件清理或分集变化时取消旧的 segments 与 works 请求。
3. 对请求响应增加当前请求归属校验；即使底层请求取消不及时，旧响应也不能更新当前页面状态。
4. 将 `AbortError` 视为正常取消，不显示为页面错误。
5. 当前 EP02 请求完成后，只渲染 EP02 返回的 `S01-S05`。

## 架构与技术方案

修改范围限定在分集控制台客户端组件，不改动服务端 `/api/segments` 的目录解析逻辑，因为接口已经能正确区分 EP01 与 EP02。

在 `src/app/works/[workId]/[epId]/page.tsx` 的数据加载 `useEffect` 中：

- 使用 `const controller = new AbortController()`。
- `fetch(..., { signal: controller.signal })` 传入取消信号。
- 在异步回调中通过 `let active = true` 或请求键 `workId/epId` 检查响应是否仍属于当前 effect。
- cleanup 中设置 `active = false`、调用 `controller.abort()`，同时保留现有轮询清理逻辑。
- effect 开始时重置本集数据状态，避免等待新请求时继续显示上一集镜头。

建议结构：

```tsx
useEffect(() => {
  const controller = new AbortController();
  let active = true;

  setChains([]);
  setSelected(null);
  setAssetCatalog([]);
  setAssetSummary(null);
  setLoadErr('');

  fetch(`/api/segments?work=${encodeURIComponent(workId)}&episode=${epId}`, {
    signal: controller.signal,
  })
    .then((r) => readApiJson<SegmentsResponse>(r))
    .then((d) => {
      if (!active) return;
      // 只用当前 effect 的数据更新状态
    })
    .catch((err) => {
      if (!active || err instanceof DOMException && err.name === 'AbortError') return;
      setLoadErr(...);
    });

  return () => {
    active = false;
    controller.abort();
    // 清理现有 polling handles
  };
}, [workId, epId]);
```

实际实现应遵循当前文件已有的 TypeScript 类型和错误处理风格，不引入新的状态管理库或额外抽象。

## 受影响文件

- `/Users/zhangzhiyu/Desktop/创作/漫剧agent/src/app/works/[workId]/[epId]/page.tsx`
  - 修改分集数据加载 `useEffect`，约第 213-260 行。
  - 增加请求取消、响应归属保护和切换时状态重置。
  - 保持镜头渲染、Prompt、资产预览、生成控制和分集导航不变。

- `/Users/zhangzhiyu/Desktop/创作/漫剧agent/.comate/specs/episode-switch-race-fix/tasks.md`
  - 记录实现和验证任务。

- `/Users/zhangzhiyu/Desktop/创作/漫剧agent/.comate/specs/episode-switch-race-fix/summary.md`
  - 记录完成结果和验证结论。

## 边界条件与异常处理

- 用户快速连续切换 EP01、EP02、EP01 时，只允许最后一次 effect 更新页面。
- 用户离开页面时，未完成的请求必须取消，旧响应不得更新卸载后的组件状态。
- 取消请求不应显示“加载失败”。
- 非取消错误仍需保留现有错误提示。
- EP02 没有视频不会影响镜头列表加载；接口返回的 `hasVideo` 只影响镜头状态。
- 如果 EP02 的 `script.json` 缺失或接口返回 404，应显示真实接口错误，而不是保留 EP01 的镜头列表。
- 现有视频任务轮询必须继续清理，不能因增加 AbortController 而改变生成任务行为。

## 数据流

```text
URL /works/人间渡/ep02
  -> params.epId = ep02
  -> effect 清空 EP01 状态
  -> 请求 /api/segments?work=人间渡&episode=ep02
  -> resolveEpisodeDir 命中 ep02/script.json
  -> 返回 S01-S05
  -> 当前 effect 校验通过
  -> setChains(S01-S05)
  -> 页面显示 EP02 镜头
```

旧请求的路径：

```text
EP01 effect cleanup
  -> active = false
  -> controller.abort()
  -> EP01 响应即使晚到也被丢弃
```

## 预期结果

- 直接打开并刷新 `/works/人间渡/ep02` 时，页面显示 `S01-S05`。
- 从 EP01 点击 EP02 后，页面不会继续保留 `S01-S07`。
- 快速切换分集时，最终页面内容与地址栏 `epId` 一致。
- `/api/segments`、类型检查和生产构建继续通过。
