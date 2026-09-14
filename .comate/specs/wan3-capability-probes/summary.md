# Wan3 三镜头能力测试完成总结

## 已完成

- 保留 EP02 正式 `script.json` 与 `C01-C16` 不变。
- 新增探针专用接口 `src/app/api/probe-produce/route.ts`。
- 接口只允许 `P01`、`P02`、`P03`，读取对应 episode 目录下的 `probes.json`。
- 对探针 ID、reference 模式、时长、参考图存在性及 `@图片N` 编号进行校验。
- 复用 `createWan3Provider`，使用标准版 Wan3、关闭 prompt_extend，并将视频输出隔离到 `media/probes/P01.mp4`、`P02.mp4`、`P03.mp4`。
- 支持 `dry=1` 非计费校验，不调用 Wan3 API。
- `npm run typecheck` 已通过。
- `npm run build` 已启动，结果待命令完成通知。

## 调用约定

```text
GET /api/probe-produce?work=人间渡&episodeDir=episodes/u1-ep01-02-叶生/ep02&probe=P01&dry=1
```

正式调用时去掉 `dry=1`。接口成功返回 Wan3 `taskId`、本地视频路径和耗时；鉴权、模型或账户失败会原样返回错误，不伪装为成功。

## 当前限制

- 尚未正式提交 P01/P02/P03 Wan3 任务，因此没有声称视频已生成。
- 三个探针仍需在用户明确执行后逐个提交，并对动作轨迹、表情、口型、声音、特效连续性和尾帧逐镜检查。
