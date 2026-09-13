/**
 * GET /api/task-status?taskId=xxx&provider=h3|wan3
 *
 * 查询单个视频生成任务状态，供前端 10s 轮询使用。
 * 返回结构化状态，不阻塞（不等待完成），调一次拿一个快照。
 *
 * 官方接口：GET /v2/query/video_generation/{task_id}
 * status 枚举：Queueing | Processing | Success | Fail
 *
 * 响应：
 *   { status: 'Queueing' | 'Processing' | 'Success' | 'Fail', message?: string }
 */
import { NextRequest } from 'next/server';

const HOST = 'https://api.minimaxi.chat';

function apiKey(): string {
  const k = process.env.MINIMAX_API_KEY;
  if (!k) throw new Error('MINIMAX_API_KEY 未配置');
  return k;
}

export async function GET(req: NextRequest) {
  const taskId = req.nextUrl.searchParams.get('taskId');
  const provider = req.nextUrl.searchParams.get('provider') ?? 'h3';
  if (!taskId) {
    return Response.json({ error: '缺少 taskId 参数' }, { status: 400 });
  }
  if (provider !== 'h3' && provider !== 'wan3') {
    return Response.json({ error: `不支持的 provider: ${provider}` }, { status: 400 });
  }

  if (provider === 'wan3') {
    try {
      const { queryWan3Task } = await import('@/core/providers/wan3');
      const data = await queryWan3Task(taskId);
      const task = data.output;
      const statusMap = {
        PENDING: 'Queueing',
        RUNNING: 'Processing',
        SUCCEEDED: 'Success',
        FAILED: 'Fail',
        CANCELED: 'Fail',
        UNKNOWN: 'Fail',
      } as const;

      return Response.json({
        taskId,
        provider,
        status: statusMap[task.task_status],
        videoUrl: task.video_url,
        message: task.message,
        raw: task,
      });
    } catch (e) {
      return Response.json({ error: String(e) }, { status: 502 });
    }
  }

  let data: Record<string, unknown>;
  try {
    const res = await fetch(`${HOST}/v2/query/video_generation/${taskId}`, {
      headers: { Authorization: `Bearer ${apiKey()}` },
      // 每次都查最新，不走浏览器缓存
      cache: 'no-store',
    });
    if (!res.ok) {
      const text = await res.text();
      return Response.json(
        { error: `MiniMax ${res.status}: ${text.slice(0, 200)}` },
        { status: 502 },
      );
    }
    data = await res.json() as Record<string, unknown>;
  } catch (e) {
    return Response.json({ error: String(e) }, { status: 502 });
  }

  // 兼容两种返回结构：
  //   旧版：{ task_id, status, file_id, message }
  //   新版：{ task: { id, status, content: { url }, ... } }
  const task = (data.task ?? data) as Record<string, unknown>;
  const status = (task.status as string | undefined) ?? 'Unknown';
  const fileId: string | undefined =
    (task.file_id as string | undefined) ??
    (task.content as Record<string, unknown> | undefined)?.file_id as string | undefined;
  const videoUrl: string | undefined =
    (task.content as Record<string, unknown> | undefined)?.url as string | undefined;
  const message: string | undefined = task.message as string | undefined;

  return Response.json({
    taskId,
    provider,
    status,
    fileId,
    videoUrl,
    message,
    raw: task,
  });
}
