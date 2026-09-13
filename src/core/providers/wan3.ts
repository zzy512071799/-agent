import { mkdir, writeFile } from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * 万相 3.0 视频生成 provider（阿里云百炼 DashScope API）。
 *
 * 接口文档：万相3.0api接入手册.md
 *
 * 官方调优建议（严格遵守）：
 * - reference_xx / file / link 类型与 first_frame / last_frame 类型互斥，不能同一请求混用。
 * - first_frame / last_frame 时 ratio 应设为 adaptive，让模型跟随输入图比例。
 * - 纯文生视频时可以指定具体 ratio（9:16 / 16:9 等）。
 * - duration=-1 触发智能时长模式。
 * - prompt_extend=true（默认）对短 prompt 改写效果明显，但增加耗时。
 * - 视频 URL 24 小时后失效，成功后立即下载。
 * - 轮询建议间隔 15s，每次调用查询接口 RPS≤20。
 * - 有视频输入时：输入总时长 + 输出时长不超过 30s。
 * - 图片限制：单边 [240,8000]px，长宽比≤8:1，≤20MB，不支持透明通道。
 *
 * 与 H3 的主要差异：
 * - 认证：Bearer WAN3_API_KEY（百炼 API key）
 * - base URL：https://dashscope.aliyuncs.com（业务空间用 X-DashScope-WorkSpace 头指定；
 *   手册里的 https://{WorkspaceId}.{region}.maas.aliyuncs.com 需要 key 被授权到该端点，
 *   我们这把没有，详见 baseUrl() 的注释）
 * - 创建任务：POST /api/v1/services/aigc/video-generation/video-synthesis + X-DashScope-Async: enable
 * - 查询任务：GET /api/v1/tasks/{task_id}
 * - 分辨率：480P / 720P / 1080P
 * - 时长：2-30s（无视频输入），最高 30fps
 * - 图片传 OSS 临时 URL 或 base64（≤20MB）
 */

const WAN3_MODEL_PRIME = 'wan3.0-video-prime'; // 高速版，能力对齐标准版
const WAN3_MODEL_STD = 'wan3.0-video';          // 标准版

function apiKey(): string {
  const k = process.env.WAN3_API_KEY;
  if (!k) throw new Error('WAN3_API_KEY 未配置，检查 .env（阿里云百炼 workspace API key）');
  return k;
}

function baseUrl(): string {
  const region = process.env.WAN3_REGION ?? 'cn-beijing';

  // 手册给的是业务空间端点 https://{WorkspaceId}.{region}.maas.aliyuncs.com。它要求
  // 这把 API Key 本身被授权到该端点上——我们这把没有，实测 403
  // `Endpoint.AccessDenied: Workspace endpoint access denied`。同一把 key 打标准端点
  // 鉴权直接通过（探针只被「模型不存在」挡下，说明已过鉴权），业务空间改用
  // `X-DashScope-WorkSpace` 请求头指定。以后这把 key 拿到端点授权，把
  // WAN3_USE_WORKSPACE_ENDPOINT 设为 1 即可切回手册那条路径。
  if (process.env.WAN3_USE_WORKSPACE_ENDPOINT === '1') {
    const workspaceId = process.env.WAN3_WORKSPACE_ID;
    if (!workspaceId) throw new Error('WAN3_WORKSPACE_ID 未配置');
    return `https://${workspaceId}.${region}.maas.aliyuncs.com`;
  }

  // 国际站是 dashscope-intl.aliyuncs.com；换区域用 WAN3_BASE_URL 覆盖。
  return process.env.WAN3_BASE_URL ?? 'https://dashscope.aliyuncs.com';
}

export type Wan3Resolution = '480P' | '720P' | '1080P';
export type Wan3Ratio = 'adaptive' | '16:9' | '4:3' | '1:1' | '3:4' | '9:16';
export type Wan3Model = 'prime' | 'standard';

export interface Wan3MediaItem {
  type: 'first_frame' | 'last_frame' | 'reference_image' | 'reference_video' | 'reference_audio';
  /** 公网 URL 或 base64 data URI。 */
  url: string;
}

export interface Wan3GenerateParams {
  prompt: string;
  /**
   * 媒体素材列表。
   * 官方限制：reference_xx 与 first_frame/last_frame 不能同时传。
   * 图片引用在 prompt 里用「图1」「图2」，视频用「视频1」，音频用「音频1」。
   */
  media?: Wan3MediaItem[];
  resolution?: Wan3Resolution;
  /**
   * 宽高比。
   * 有 first_frame / last_frame 时必须用 adaptive，让模型跟随输入图比例；
   * 纯文生视频时指定具体比例。
   */
  ratio?: Wan3Ratio;
  /**
   * 时长（秒）。无视频输入范围 [2,30]，传 -1 为智能时长模式。
   */
  durationSec?: number;
  /** 是否包含音频（默认 true）。 */
  audio?: boolean;
  /** prompt 智能改写（默认 true，对短 prompt 效果明显）。 */
  promptExtend?: boolean;
  /** 高速版 prime（默认）还是标准版 standard。 */
  model?: Wan3Model;
  outPath: string;
  /** 任务提交成功后回调 task_id，供前端实时展示轮询状态。 */
  onTaskCreated?: (taskId: string) => void;
}

export interface Wan3GenerateResult {
  path: string;
  taskId: string;
  elapsedSec: number;
  videoUrl: string;
}

export interface Wan3ProviderOptions {
  pollIntervalSec?: number;
  timeoutSec?: number;
}

interface CreateTaskResponse {
  output: { task_id: string; task_status: string };
  request_id: string;
}

interface QueryTaskResponse {
  output: {
    task_id: string;
    task_status: 'PENDING' | 'RUNNING' | 'SUCCEEDED' | 'FAILED' | 'CANCELED' | 'UNKNOWN';
    video_url?: string;
    code?: string;
    message?: string;
  };
  request_id: string;
}

/** 查询单个万相任务快照，不等待任务完成。 */
export async function queryWan3Task(taskId: string): Promise<QueryTaskResponse> {
  return wan3Request<QueryTaskResponse>(`/api/v1/tasks/${taskId}`);
}

async function wan3Request<T>(path: string, init?: RequestInit): Promise<T> {
  // **默认不发 X-DashScope-WorkSpace。**
  // 这把 key 对 ws-ydv95rj8f58l75o0 没有权限：带上这个头就 403
  // `Workspace.AccessDenied: Workspace access denied.`，不带就正常鉴权并跑在 key 自己的
  // 默认业务空间里。注意模型名校验发生在业务空间鉴权**之前**——所以拿一个不存在的模型名
  // 去探针，会被「Model not exist」提前挡下，测不出这个头有没有问题。
  // 以后 key 拿到该空间授权，把 WAN3_SEND_WORKSPACE_HEADER 设为 1 再带上。
  const workspaceId = process.env.WAN3_WORKSPACE_ID;
  const sendWorkspaceHeader =
    process.env.WAN3_SEND_WORKSPACE_HEADER === '1' || process.env.WAN3_USE_WORKSPACE_ENDPOINT === '1';
  const res = await fetch(`${baseUrl()}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${apiKey()}`,
      'Content-Type': 'application/json',
      ...(sendWorkspaceHeader && workspaceId ? { 'X-DashScope-WorkSpace': workspaceId } : {}),
      ...init?.headers,
    },
  });
  const text = await res.text();
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error(`万相3.0 返回非 JSON (${res.status}): ${text.slice(0, 300)}`);
  }
  if (!res.ok) {
    const e = parsed as { code?: string; message?: string };
    throw new Error(`万相3.0 ${res.status} [${e.code ?? ''}]: ${e.message ?? text.slice(0, 200)}`);
  }
  return parsed as T;
}

/** 上传本地图片为 base64 data URI（≤20MB，官方格式）。 */
async function toDataUri(imagePath: string): Promise<string> {
  const abs = resolve(imagePath);
  const buf = readFileSync(abs);
  if (buf.length > 20 * 1024 * 1024) {
    throw new Error(`图片超过 20MB 限制: ${imagePath}`);
  }
  const ext = abs.split('.').pop()?.toLowerCase() ?? 'png';
  const mime = ext === 'jpg' || ext === 'jpeg' ? 'image/jpeg' : 'image/png';
  return `data:${mime};base64,${buf.toString('base64')}`;
}

/**
 * 把本地路径的 media item 转成 API 需要的格式（本地文件转 base64）。
 * 公网 URL 直接透传。
 */
async function resolveMediaItem(item: Wan3MediaItem): Promise<{ type: string; url: string }> {
  const url = item.url;
  // 公网 URL 直接用
  if (url.startsWith('http://') || url.startsWith('https://') || url.startsWith('data:')) {
    return { type: item.type, url };
  }
  // 本地文件 → base64
  const abs = resolve(url);
  if (!existsSync(abs)) throw new Error(`媒体文件不存在: ${url}`);
  if (item.type === 'reference_video' || item.type === 'reference_audio') {
    // 视频/音频暂不支持 base64 直传（官方要求公网 URL 或 OSS 临时 URL），抛出提示
    throw new Error(
      `万相3.0 视频/音频素材必须提供公网 URL 或 OSS 临时 URL，不支持本地路径: ${url}`,
    );
  }
  // 图片 → base64
  return { type: item.type, url: await toDataUri(abs) };
}

/**
 * 官方调优：检查 media 数组的互斥约束。
 * reference_xx / file / link 与 first_frame / last_frame 不能混用。
 */
function validateMedia(media: Wan3MediaItem[]): void {
  const hasFrame = media.some((m) => m.type === 'first_frame' || m.type === 'last_frame');
  const hasRef = media.some(
    (m) => m.type === 'reference_image' || m.type === 'reference_video' || m.type === 'reference_audio',
  );
  if (hasFrame && hasRef) {
    throw new Error(
      '万相3.0：reference_xx 与 first_frame/last_frame 互斥，不能在同一请求中混用（官方硬限制）',
    );
  }
  const firstFrames = media.filter((m) => m.type === 'first_frame').length;
  const lastFrames = media.filter((m) => m.type === 'last_frame').length;
  if (firstFrames > 1) throw new Error('万相3.0：first_frame 最多1张');
  if (lastFrames > 1) throw new Error('万相3.0：last_frame 最多1张');
  const refImages = media.filter((m) => m.type === 'reference_image').length;
  if (refImages > 10) throw new Error('万相3.0：reference_image 最多10张');
}

export function createWan3Provider(opts: Wan3ProviderOptions = {}) {
  const pollInterval = (opts.pollIntervalSec ?? 15) * 1000;
  const timeoutSec = opts.timeoutSec ?? 1800;

  return {
    async generate(params: Wan3GenerateParams): Promise<Wan3GenerateResult> {
      const {
        prompt,
        media = [],
        resolution = '720P',
        durationSec = 5,
        audio = true,
        promptExtend = true,
        model = 'prime',
        outPath,
        onTaskCreated,
      } = params;

      // 官方调优：有首/尾帧时 ratio 用 adaptive
      const hasFrame = media.some((m) => m.type === 'first_frame' || m.type === 'last_frame');
      const ratio: Wan3Ratio = params.ratio ?? (hasFrame ? 'adaptive' : '9:16');

      if (media.length > 0) validateMedia(media);

      // 构建请求体
      const input: Record<string, unknown> = { prompt };
      if (media.length > 0) {
        input.media = await Promise.all(media.map(resolveMediaItem));
      }

      const body: Record<string, unknown> = {
        model: model === 'prime' ? WAN3_MODEL_PRIME : WAN3_MODEL_STD,
        input,
        parameters: {
          resolution,
          ratio,
          duration: durationSec,
          audio,
          prompt_extend: promptExtend,
        },
      };

      const started = Date.now();
      const created = await wan3Request<CreateTaskResponse>(
        '/api/v1/services/aigc/video-generation/video-synthesis',
        {
          method: 'POST',
          headers: { 'X-DashScope-Async': 'enable' },
          body: JSON.stringify(body),
        },
      );

      const taskId = created.output.task_id;
      if (typeof onTaskCreated === 'function') onTaskCreated(taskId);

      // 轮询（官方建议 15s 间隔）
      const done = await pollWan3Task(taskId, pollInterval, timeoutSec);

      if (!done.output.video_url) {
        throw new Error(`万相3.0 任务成功但无视频 URL: task=${taskId}`);
      }

      // 下载视频到本地
      const videoUrl = done.output.video_url;
      await mkdir(resolve(outPath, '..'), { recursive: true });
      const resp = await fetch(videoUrl);
      if (!resp.ok) throw new Error(`下载视频失败 (${resp.status}): ${videoUrl}`);
      await writeFile(outPath, Buffer.from(await resp.arrayBuffer()));

      return {
        path: outPath,
        taskId,
        elapsedSec: (Date.now() - started) / 1000,
        videoUrl,
      };
    },
  };
}

export type Wan3Provider = ReturnType<typeof createWan3Provider>;

async function pollWan3Task(
  taskId: string,
  intervalMs: number,
  timeoutSec: number,
): Promise<QueryTaskResponse> {
  const deadline = Date.now() + timeoutSec * 1000;

  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, intervalMs));
    const result = await queryWan3Task(taskId);

    switch (result.output.task_status) {
      case 'SUCCEEDED':
        return result;
      case 'FAILED':
        throw new Error(
          `万相3.0 任务失败 task=${taskId}: [${result.output.code ?? ''}] ${result.output.message ?? '未知错误'}`,
        );
      case 'CANCELED':
        throw new Error(`万相3.0 任务已取消 task=${taskId}`);
      case 'UNKNOWN':
        throw new Error(`万相3.0 任务不存在或已过期（24h 有效期）: task=${taskId}`);
      // PENDING / RUNNING：继续等待
    }
  }
  throw new Error(`万相3.0 任务超时 ${timeoutSec}s task=${taskId}`);
}
