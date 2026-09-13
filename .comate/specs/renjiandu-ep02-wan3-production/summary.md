# 《人间渡》EP02 Wan3 生产准备总结

## 已完成

- 创建 EP02 正式生产数据：
  - `storage/works/人间渡/episodes/u1-ep01-02-叶生/ep02/script.json`
  - S01-S05，共 5 个 30 秒镜头。
  - 全部使用 Wan3 `reference` 模式。
  - S01-S05 的 Prompt、对白、音效、结束状态和镜头承接已写入。
- S01 加入单元次集片头过渡卡：单元名「叶生」、集名「可曾活过」、第 2 集，约 2 秒，无旁白、无题眼。
- 复制 EP01 已核验的角色、道具和书房素材到 EP02 私有媒体目录。
- 将 EP01 S07 真实尾帧复制为 EP02 `media/videos/S07_last_actual.png`，作为 S01 的跨集连续性参考。
- 生成并落盘 EP02 独有场景图：
  - `media/images/场景/旧宅门外棺前.png`
- 修正 EP02 台词表：
  - 场 2 台词说话者修正为叶生/闻笙。
  - 场 4 两句闻笙提问补入。
  - 场 5 叶生最后问题和阿离「他走啦？」补入。

## 关键修正

- S01 原本同时在 `wan3ReferencePaths` 和 `wan3FirstFrameFrom` 声明 S07 尾帧，导致尾帧重复传入；已删除静态数组中的重复项。
- S01 已使用标准“前一镜真实尾帧”标记，避免共享引用编译器错误平移 `@图片N`。
- 最终 S01 media 顺序为：
  1. `S07_last_actual.png`
  2. `闻笙-正面.png`
  3. `叶生.png`
  4. `铃.png`
  5. `旧宅门外棺前.png`

## 验证结果

- EP02 `/api/segments` 成功返回 S01-S05。
- `assetSummary.status` 为 `ready`。
- 静态图片 8 张，缺失引用 0，问题 0。
- S01-S05 所有 Prompt token 均与依赖卡片闭合：
  - S01：5 个 token / 5 个图片依赖。
  - S02：3 / 3。
  - S03：2 / 2。
  - S04：3 / 3。
  - S05：6 / 6。
- 所有镜头参考图数量不超过 10 张。
- `npm run typecheck`：通过。
- `npm run build`：通过；仅保留已有 Next.js 动态文件系统 tracing 警告。
- 480P Wan3 dry-run：S01 已成功进入请求编排且没有创建付费任务；S02-S05 在 dry-run 中因不会伪造新尾帧而阻断，这是预期行为。

## 后续生成顺序

1. 先生成 EP02 S01。
2. S01 成功后自动得到 `S01_last_actual.png`。
3. 再生成 S02，依次生成 S03、S04、S05。
4. 不要并行提交 S02-S05，也不要在缺少真实尾帧时用静态设计图代替。

当前百炼账户若仍处于 `Arrearage` 状态，正式生成会被服务端拒绝；dry-run 不受该账单状态影响。