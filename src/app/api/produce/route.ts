/**
 * SSE 生成接口。前端通过 EventSource 订阅，每段生成完推送一个事件。
 *
 * GET /api/produce?work=地下三层&episode=ep01&resolution=480P&provider=wan3&chain=吊篮
 * GET /api/produce?work=地下三层&episode=ep01&resolution=480P&provider=wan3&segment=S04
 *
 * provider 参数：
 *   h3   → MiniMax H3（历史链路）分辨率档位：768p / 1440p
 *   wan3 → 万相3.0（阿里云百炼）分辨率档位：480P / 720P / 1080P
 *   model 参数只对 wan3 生效：standard（默认，wan3.0-video）/ prime（1.5 倍价）
 *
 * wan3 分支不走 H3 的三字段编译器，提示词正文与模式的唯一真相是
 * script.json 的 shots[].wan3Prompt / shots[].wan3Mode。
 *
 * 事件类型：
 *   start         { message }
 *   seg:start     { chain, seg, mode, duration }
 *   seg:task      { chain, seg, taskId }
 *   seg:done      { chain, seg, elapsed, path }
 *   seg:skip      { chain, seg, reason }
 *   seg:warn      { chain, seg, warning }
 *   seg:fail      { chain, seg, error }
 *   done          {}
 */
import { existsSync, readFileSync } from 'node:fs';
import { execFile } from 'node:child_process';
import { mkdir } from 'node:fs/promises';
import { isAbsolute, join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { NextRequest } from 'next/server';
import { declaredEpisodeDir, resolveEpisodeDir } from '@/core/work';
import type { Wan3MediaItem } from '@/core/providers/wan3';
import { buildWan3ReferencePlan, validateWan3ImageTokens, type Wan3ImageRef } from '@/core/pipeline/wan3-media';

const execFileAsync = promisify(execFile);

const WORKS = resolve(process.cwd(), 'storage/works');

// H3 时期为《下山只想躺平》硬编码的 FL2VA 段号，只在 h3 分支用于抑制尾帧传播。
// wan3 分支不看这张表，改由每段自己声明（wan3Mode / wan3FirstFrameFrom）。
const H3_FL2VA_SEGS = new Set(['S06', 'S12']);

function elapsed(t0: number): number {
  return Math.round((Date.now() - t0) / 1000);
}

/**
 * 抽出视频的真实最后一帧，供下一段当首帧用（本地 ffmpeg，不花钱）。
 *
 * **不要用 `-sseof -0.042 -frames:v 1`。**那个窗口太窄，末帧的时间戳常常落在窗口之外，
 * ffmpeg 会打印 "Output file is empty, nothing was encoded" 然后**以退出码 0 结束**——
 * try/catch 抓不到，于是链式衔接静默退回设计首帧。实测 ep01 的 S02 就是这么丢的。
 *
 * 改成解码最后 1 秒并用 `-update 1` 逐帧覆盖同一个文件，最终留下的就是最后一帧；
 * 再显式确认文件存在，把「静默没产出」变成异常。
 */
async function extractLastFrame(videoPath: string, outPath: string): Promise<void> {
  await execFileAsync('ffmpeg', [
    '-v', 'error',
    '-sseof', '-1',
    '-i', videoPath,
    '-an',
    '-update', '1',
    '-q:v', '1',
    '-y',
    outPath,
  ]);
  if (!existsSync(outPath)) {
    throw new Error(`ffmpeg 未产出尾帧（退出码为 0 但文件不存在）: ${outPath}`);
  }
}

/** 从 project.json sceneShotRanges 或 shots 数组构建链定义 */
function buildChains(
  projectJson: Record<string, unknown> | null,
  epId: string,
  shots: Array<Record<string, unknown>>,
): Record<string, string[]> {
  if (projectJson) {
    const eps = (projectJson.episodes as Array<Record<string, unknown>>) ?? [];
    const epNum = parseInt(epId.replace('ep', ''), 10);
    const epDef = eps.find((e) => e.episode === epNum);
    if (epDef?.sceneShotRanges) {
      return epDef.sceneShotRanges as Record<string, string[]>;
    }
  }
  // 回退：按 sceneId 从 shots 分组，保留 segmentId 顺序
  const seen = new Map<string, string[]>();
  for (const shot of shots) {
    const sid = (shot.segmentId ?? shot.sceneId) as string;
    if (!sid) continue;
    const sceneId = (shot.sceneId ?? shot.segmentId) as string;
    if (!seen.has(sceneId)) seen.set(sceneId, []);
    if (!seen.get(sceneId)!.includes(sid)) seen.get(sceneId)!.push(sid);
  }
  const out: Record<string, string[]> = {};
  for (const [k, v] of seen) out[k] = v;
  return out;
}

type Wan3Mode = 'first_frame' | 'first_last_frame' | 'reference' | 't2v';

interface Wan3Plan {
  mode: Wan3Mode;
  prompt: string;
  durationSec: number;
  media: Wan3MediaItem[];
  frameApprovalRequired: boolean;
  frameApprovalGranted: boolean;
}

/**
 * 从 script.json 的原始 shot 对象（未过 zod，wan3 字段不能被 strip）编排一段 wan3 请求。
 *
 * 全部素材与模式都必须是段自己声明的，这里不做任何猜测：猜错一次就是一次真金白银的
 * 重出。不满足就抛，让 seg:fail 把原因喊出来。
 */
function basename(p: string): string {
  return p.split('/').pop() ?? p;
}

function resolveWorkAsset(workDir: string, pathValue: string): string {
  const candidate = isAbsolute(pathValue) || pathValue.startsWith('storage/works/')
    ? resolve(process.cwd(), pathValue)
    : resolve(workDir, pathValue);
  const worksRoot = resolve(process.cwd(), 'storage/works');
  if (candidate !== worksRoot && !candidate.startsWith(`${worksRoot}/`)) {
    throw new Error(`素材路径超出作品目录：${pathValue}`);
  }
  return candidate;
}

function pathList(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((p): p is string => typeof p === 'string' && p.trim() !== '') : [];
}

function collectReferencePaths(
  lead: Record<string, unknown>,
  script: Record<string, unknown>,
): string[] {
  const characters = (script.characters as Array<Record<string, unknown>>) ?? [];
  const scenes = (script.scenes as Array<Record<string, unknown>>) ?? [];
  const rejected = new Set(
    [...characters, ...scenes]
      .filter((item) => (item.refImageReview as Record<string, unknown> | undefined)?.status === 'mismatch')
      .map((item) => item.refImagePath)
      .filter((item): item is string => typeof item === 'string'),
  );
  const valid = (paths: string[]) => [...new Set(paths)].filter((path) => !rejected.has(path));

  const explicit = pathList(lead.wan3ReferencePaths);
  if (explicit.length > 0) return valid(explicit);

  const paths: string[] = [];
  const characterIds = pathList(lead.characterIds);
  for (const id of characterIds) {
    const character = characters.find((item) => item.id === id);
    if (typeof character?.refImagePath === 'string') paths.push(character.refImagePath);
  }
  const scene = scenes.find((item) => item.id === lead.sceneId);
  if (typeof scene?.refImagePath === 'string') paths.push(scene.refImagePath);
  paths.push(...pathList(lead.propPaths), ...pathList(lead.compositionPaths));
  return valid(paths);
}

function planWan3(
  segId: string,
  segShots: Array<Record<string, unknown>>,
  prevActualLastFrame: string | null,
  workDir: string,
  script: Record<string, unknown>,
): Wan3Plan {
  const lead = segShots.find(
    (s) => typeof s.wan3Prompt === 'string' && (s.wan3Prompt as string).trim() !== '',
  );
  if (!lead) {
    throw new Error(`${segId} 没有 wan3Prompt，先把提示词写进 script.json 再跑`);
  }
  let prompt = (lead.wan3Prompt as string).trim();
  const approvalShots = segShots.filter((s) => s.requiresFrameApproval === true);
  const frameApprovalRequired = approvalShots.length > 0;
  const frameApprovalGranted = frameApprovalRequired
    ? approvalShots.every((s) => s.frameApprovalStatus === 'approved')
    : true;

  const durationSec = segShots.reduce((sum, s) => sum + (Number(s.durationSec) || 0), 0);
  if (durationSec < 2 || durationSec > 30) {
    throw new Error(`${segId} 时长 ${durationSec}s 超出万相3.0 的 [2,30]，先在镜段表里改切法`);
  }

  const mode = (lead.wan3Mode as Wan3Mode | undefined) ?? 't2v';
  const media: Wan3MediaItem[] = [];
  const declaredReferencePaths = pathList(lead.wan3ReferencePaths);

  if ((mode === 'first_frame' || mode === 'first_last_frame') && declaredReferencePaths.length > 0) {
    throw new Error(`${segId} 是 ${mode} 模式，但声明了 reference_image；首帧模式不能在请求中混用额外参考图，请切换为 reference 模式或移除 wan3ReferencePaths`);
  }

  if (mode === 'first_frame' || mode === 'first_last_frame') {
    // 链内段可以声明「首帧取上一段的真实输出尾帧」；没声明就一律用定稿的设计首帧，
    // 免得把精修过的首帧（例如 S04 那五道指甲刮槽）交给模型自己重画。
    const inheritFrom = lead.wan3FirstFrameFrom as string | undefined;
    let firstFrame: string | null = null;
    if (inheritFrom && prevActualLastFrame && existsSync(prevActualLastFrame)) {
      firstFrame = prevActualLastFrame;
    } else if (typeof lead.firstFramePath === 'string') {
      firstFrame = resolveWorkAsset(workDir, lead.firstFramePath);
    }
    if (!firstFrame || !existsSync(firstFrame)) {
      throw new Error(`${segId} 模式是 ${mode} 但首帧图不存在：${firstFrame ?? '未声明 firstFramePath'}`);
    }
    media.push({ type: 'first_frame', url: firstFrame });

    if (mode === 'first_last_frame') {
      const tail = segShots[segShots.length - 1];
      const lastPath = tail.lastFramePath ?? lead.lastFramePath;
      if (typeof lastPath !== 'string' || !existsSync(resolveWorkAsset(workDir, lastPath))) {
        throw new Error(`${segId} 模式是 first_last_frame 但尾帧图不存在：${String(lastPath)}`);
      }
      media.push({ type: 'last_frame', url: resolveWorkAsset(workDir, lastPath) });
    }
  } else if (mode === 'reference') {
    if (lead.firstFramePath) {
      throw new Error(
        `${segId} 走全能参考却带着 firstFramePath——reference_* 与 first_frame 在同一请求里互斥`,
      );
    }
    const inheritedSegment = lead.wan3FirstFrameFrom as string | undefined;
    const inheritedFrame = inheritedSegment
      ? join(workDir, 'media/videos', `${inheritedSegment}_last_actual.png`)
      : null;
    const continuityPath = inheritedFrame && existsSync(inheritedFrame)
      ? inheritedFrame
      : inheritedSegment && prevActualLastFrame && existsSync(prevActualLastFrame)
        ? prevActualLastFrame
        : null;
    if (lead.wan3FirstFrameFrom && !continuityPath) {
      throw new Error(`${segId} 声明继承 ${lead.wan3FirstFrameFrom}，但前一镜没有真实尾帧；不能用设计首帧替代连续性参考`);
    }
    const refs = continuityPath
      ? [continuityPath, ...collectReferencePaths(lead, script)]
      : collectReferencePaths(lead, script);
    if (refs.length === 0) {
      throw new Error(`${segId} 走全能参考但没有可用参考图；请补充角色、场景、道具引用或 wan3ReferencePaths`);
    }
    if (refs.length > 10) throw new Error(`${segId} reference_image ${refs.length} 张，超过 10 张上限`);
    for (const r of refs) {
      if (!existsSync(resolveWorkAsset(workDir, r))) throw new Error(`${segId} 参考图不存在：${r}`);
      media.push({ type: 'reference_image', url: resolveWorkAsset(workDir, r) });
    }
    prompt = buildWan3ReferencePlan(prompt, refs, continuityPath).prompt;
    // 音色样本只接公网 URL：provider 里视频/音频不支持 base64 直传。
    const audioUrls = (lead.wan3ReferenceAudioUrls as string[] | undefined) ?? [];
    if (audioUrls.length === 0 && lead.requiresVoiceRef === true) {
      throw new Error(
        `${segId} 需要先有音色样本（reference_audio）才能跑：没有样本，这一段里的角色会是另一个人的声音。先跑取样段、截 ≤15 秒、上传拿公网 URL，写进 wan3ReferenceAudioUrls`,
      );
    }
    for (const u of audioUrls.slice(0, 5)) {
      media.push({ type: 'reference_audio', url: u });
    }
  }

  let imageIndex = 0;
  const imageRefs: Wan3ImageRef[] = media.flatMap((item) => {
    if (item.type !== 'first_frame' && item.type !== 'last_frame' && item.type !== 'reference_image') return [];
    imageIndex += 1;
    const path = item.url;
    const isRemote = /^https?:\/\//.test(path) || path.startsWith('data:');
    const exists = isRemote || existsSync(path);
    return [{
      index: imageIndex,
      token: `@图片${imageIndex}`,
      name: basename(path),
      path,
      role: item.type,
      exists,
      uploadable: exists,
    }];
  });
  const referenceErrors = validateWan3ImageTokens(prompt, imageRefs);
  if (referenceErrors.length > 0) {
    throw new Error(`${segId} 图片引用校验失败：${referenceErrors.join('；')}`);
  }

  return {
    mode,
    prompt,
    durationSec,
    media,
    frameApprovalRequired,
    frameApprovalGranted,
  };
}

export async function GET(req: NextRequest) {
  const workId = req.nextUrl.searchParams.get('work');
  const epId = req.nextUrl.searchParams.get('episode') ?? 'ep01';
  const resolution = req.nextUrl.searchParams.get('resolution') ?? '768p';
  const chainFilter = req.nextUrl.searchParams.get('chain') ?? null;
  const segmentFilter = req.nextUrl.searchParams.get('segment') ?? null;
  const provider = (req.nextUrl.searchParams.get('provider') ?? 'h3') as 'h3' | 'wan3';
  // 万相标准版 / 高速版。prime 能力对齐但单价 1.5 倍，所以默认标准版，要用得显式点名。
  const wan3Model = (req.nextUrl.searchParams.get('model') ?? 'standard') as 'standard' | 'prime';
  // dry=1：只编排不发请求。用来在花钱之前核对每段的模式、时长与素材角色。
  const dryRun = req.nextUrl.searchParams.get('dry') === '1';

  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      const send = (event: string, data?: unknown) => {
        const payload = `event: ${event}\ndata: ${JSON.stringify(data ?? {})}\n\n`;
        controller.enqueue(encoder.encode(payload));
      };

      try {
        if (!workId) {
          send('seg:fail', { chain: '', seg: '', error: '缺少 work 参数' });
          send('done');
          controller.close();
          return;
        }

        const workDir = join(WORKS, workId);

        const projectPath = join(workDir, 'project.json');
        const projectJson: Record<string, unknown> | null = existsSync(projectPath)
          ? JSON.parse(readFileSync(projectPath, 'utf8'))
          : null;

        // 长剧的集目录按故事单元分组（episodes/u1-ep01-02-…/ep01），不能直接拼
        // episodes/<epId>。这里和 /api/works、/api/segments 用同一个解析器。
        const epDir = resolveEpisodeDir(workDir, epId, declaredEpisodeDir(projectJson, epId));
        const IMAGES_DIR = join(epDir, 'media/images');
        const VIDEOS_DIR = join(epDir, 'media/videos');

        await mkdir(VIDEOS_DIR, { recursive: true });

        const scriptPath = join(epDir, 'script.json');
        if (!existsSync(scriptPath)) {
          send('seg:fail', { chain: '', seg: '', error: `script.json 不存在: ${scriptPath}` });
          send('done');
          controller.close();
          return;
        }

        const raw = JSON.parse(readFileSync(scriptPath, 'utf8'));
        const rawShots = raw.shots as Array<Record<string, unknown>>;
        const scriptRatio =
          raw.parameters && typeof raw.parameters === 'object' && raw.parameters.ratio === '16:9'
            ? '16:9'
            : '9:16';

        const { Script, Shot } = await import('@/core/schema');
        type ShotType = import('@/core/schema').Shot;
        const { compileSegmentH3 } = await import('@/core/pipeline/h3');
        const { createH3Provider } = await import('@/core/providers/h3api');
        const { createWan3Provider } = await import('@/core/providers/wan3');

        // zod 校验只服务 h3 分支：那套 enum（cameraMove / shotSize / role）是 H3 三字段
        // 编译器的输入契约。wan3 分支的提示词是手写的，不读这些字段，不该被它们挡住。
        const h3Script = provider === 'h3' ? Script.parse(raw.script) : null;
        const wan3Script = raw.script as Record<string, unknown>;
        const shots = provider === 'h3' ? (raw.shots as unknown[]).map((s) => Shot.parse(s)) : [];
        const h3 = createH3Provider({ workDir: epDir });
        const wan3 = createWan3Provider();

        const chains = buildChains(projectJson, epId, rawShots);
        if (chainFilter && !chains[chainFilter]) {
          send('seg:fail', {
            chain: chainFilter,
            seg: '',
            error: `链「${chainFilter}」不存在。可用链：${Object.keys(chains).join('、')}`,
          });
          send('done');
          controller.close();
          return;
        }
        const chainEntries = chainFilter
          ? ([[chainFilter, chains[chainFilter]]] as [string, string[]][])
          : (Object.entries(chains) as [string, string[]][]);
        const filteredEntries = segmentFilter
          ? chainEntries
              .map(([name, ids]) => [name, ids.filter((id) => id === segmentFilter)] as [string, string[]])
              .filter(([, ids]) => ids.length > 0)
          : chainEntries;
        if (segmentFilter && filteredEntries.length === 0) {
          send('seg:fail', {
            chain: chainFilter ?? '',
            seg: segmentFilter,
            error: `镜段「${segmentFilter}」不存在或不属于指定链`,
          });
          send('done');
          controller.close();
          return;
        }

        send('start', { message: `开始生成 ${workId} / ${epId}${segmentFilter ? ` 镜段${segmentFilter}` : chainFilter ? ' 链' + chainFilter : ' 全集'}（${resolution} · ${provider === 'wan3' ? `万相3.0 ${wan3Model}` : 'H3'}）` });

        for (const [chainName, segIds] of filteredEntries) {
          let prevActualLastFrame: string | null = null;

          for (const segId of segIds) {
            const outPath = join(VIDEOS_DIR, `${segId}.mp4`);
            const actualLastFramePath = join(VIDEOS_DIR, `${segId}_last_actual.png`);

            if (existsSync(outPath)) {
              send('seg:skip', { chain: chainName, seg: segId, reason: '视频已存在' });
              if (existsSync(actualLastFramePath) && !H3_FL2VA_SEGS.has(segId)) {
                prevActualLastFrame = actualLastFramePath;
              } else {
                prevActualLastFrame = null;
              }
              continue;
            }

            const rawSegShots = rawShots.filter(
              (s) => s.segmentId === segId || s.sceneId === segId,
            );
            const segShots = shots.filter(
              (s) =>
                (s as { segmentId?: string }).segmentId === segId ||
                s.sceneId === segId,
            );
            if (rawSegShots.length === 0) {
              prevActualLastFrame = null;
              continue;
            }

            // ─── 编排 ─────────────────────────────────────────────────────
            // wan3：模式与提示词正文全部由段自己在 script.json 里声明，不猜。
            // h3  ：沿用三字段编译器（《下山只想躺平》的历史链路）。
            let wan3Plan: Wan3Plan | null = null;
            let compiled: Awaited<ReturnType<typeof compileSegmentH3>> | null = null;

            if (provider === 'wan3') {
              try {
                wan3Plan = planWan3(segId, rawSegShots, prevActualLastFrame, epDir, wan3Script);
              } catch (e) {
                send('seg:fail', { chain: chainName, seg: segId, error: (e as Error).message });
                prevActualLastFrame = null;
                continue;
              }
            } else {
              const firstShot = segShots[0] as ShotType & { firstFramePath?: string; lastFramePath?: string };
              const lastShot = segShots[segShots.length - 1] as ShotType & { lastFramePath?: string };

              const designFirstFrame = firstShot.firstFramePath
                ? resolveWorkAsset(workDir, firstShot.firstFramePath)
                : null;
              const firstFramePath = prevActualLastFrame ?? designFirstFrame;

              // sceneId 是真实场景 id（如 episode-1-scene-0），segmentId 是镜段标签（S01）
              const sceneId = segShots[0].sceneId;
              const shotsForSeg = shots.filter(
                (s) => (s as { segmentId?: string }).segmentId === segId,
              );
              const shotsToCompile = shotsForSeg.length > 0 ? shotsForSeg : segShots;

              // 把首/尾帧路径传给 compileSegmentH3，让它自动选 I2VA 还是 Ref2VA 格式
              try {
                compiled = compileSegmentH3(h3Script!, shotsToCompile, sceneId, IMAGES_DIR, {
                  firstFramePath: (firstFramePath && existsSync(firstFramePath)) ? firstFramePath : null,
                  lastFramePath: H3_FL2VA_SEGS.has(segId) && lastShot.lastFramePath
                    ? (
                        existsSync(resolveWorkAsset(workDir, lastShot.lastFramePath))
                          ? resolveWorkAsset(workDir, lastShot.lastFramePath)
                          : null
                      )
                    : null,
                });
              } catch (e) {
                send('seg:fail', { chain: chainName, seg: segId, error: (e as Error).message });
                prevActualLastFrame = null;
                continue;
              }
            }

            const mode = wan3Plan ? wan3Plan.mode : compiled!.mode;
            const durationSec = wan3Plan ? wan3Plan.durationSec : compiled!.durationSec;

            send('seg:start', {
              chain: chainName,
              seg: segId,
              mode,
              duration: durationSec,
              media: wan3Plan?.media.map((m) => `${m.type}=${m.url.split('/').pop()}`),
              promptChars: wan3Plan?.prompt.length,
              frameApproval: wan3Plan?.frameApprovalRequired
                ? (wan3Plan.frameApprovalGranted ? 'approved' : 'pending')
                : 'not_required',
            });
            const t0 = Date.now();

            if (dryRun) {
              send('seg:skip', { chain: chainName, seg: segId, reason: '校验模式，未调用 API' });
              prevActualLastFrame = null;
              continue;
            }

            if (
              provider === 'wan3' &&
              wan3Plan?.frameApprovalRequired &&
              !wan3Plan.frameApprovalGranted
            ) {
              send('seg:fail', {
                chain: chainName,
                seg: segId,
                error: `${segId} 的关键状态帧尚未人工确认。检查首尾帧与逐段 prompt 后，把该段 frameApprovalStatus 设为 approved；当前禁止创建付费视频任务`,
              });
              prevActualLastFrame = null;
              continue;
            }

            try {
              let result: { path: string; taskId: string; elapsedSec: number };

              if (provider === 'wan3') {
                // ─── 万相3.0 路径 ───────────────────────────────────────────
                const plan = wan3Plan!;
                const wan3Res = resolution === '1080P' ? '1080P' : resolution === '480P' ? '480P' : '720P';

                result = await wan3.generate({
                  prompt: plan.prompt,
                  media: plan.media.length > 0 ? plan.media : undefined,
                  resolution: wan3Res as '480P' | '720P' | '1080P',
                  // 必须显式传入作品比例，不能让 adaptive 猜测，也不能把横屏作品
                  // 错发成竖屏。《昨晚在商K点了一个产品经理》是 16:9，
                  // 《地下三层》等竖屏作品回退为 9:16。
                  ratio: plan.media.some((item) => item.type === 'first_frame' || item.type === 'last_frame')
                    ? 'adaptive'
                    : scriptRatio,
                  durationSec: plan.durationSec,
                  audio: true,
                  // prompt_extend 会用大模型改写提示词，破坏锁定的风格锚、角色外形与
                  // 逐字台词——跨镜一致性头号杀手。正式出片一律 false。
                  promptExtend: false,
                  model: wan3Model === 'prime' ? 'prime' : 'standard',
                  outPath,
                  onTaskCreated: (taskId) => {
                    send('seg:task', { chain: chainName, seg: segId, taskId });
                  },
                });
              } else {
                // ─── MiniMax H3 路径 ───────────────────────────────────────
                // compiled.references 已按模式分好：
                //   I2VA/FL2VA → [first_frame, ?last_frame]
                //   Ref2VA     → [reference_image, ...]
                const c = compiled!;
                const allRefs: Array<{ path: string; role: 'first_frame' | 'last_frame' | 'reference_image' }> =
                  c.mode === 'I2VA' || c.mode === 'FL2VA'
                    ? c.references.map((r) => ({
                        path: r.path,
                        role: r.label === 'last_frame' ? 'last_frame' : 'first_frame',
                      } as { path: string; role: 'first_frame' | 'last_frame' | 'reference_image' }))
                    : c.references.map((r) => ({ path: r.path, role: 'reference_image' as const }));

                const ratio = (c.mode === 'T2VA' || c.mode === 'Ref2VA')
                  ? (h3Script?.aspectRatio ?? '9:16')
                  : undefined;

                result = await h3.generate({
                  prompt: c.prompt,
                  references: allRefs.filter((r) => existsSync(r.path)),
                  durationSec: c.durationSec,
                  resolution: resolution as '768p' | '1440p',
                  ratio,
                  outPath,
                  onTaskCreated: (taskId) => {
                    send('seg:task', { chain: chainName, seg: segId, taskId });
                  },
                });
              }

              send('seg:done', {
                chain: chainName,
                seg: segId,
                elapsed: elapsed(t0),
                path: result.path,
              });

              // 真实尾帧一律抽出来存档（本地 ffmpeg，不花钱），但只有下一段自己声明了
              // wan3FirstFrameFrom 才会被当成首帧用。抽不出来必须报出来——静默退回设计
              // 首帧会让链式衔接失效，而这件事在成片里表现为「两段之间跳一下」，
              // 事后极难归因。
              if (provider === 'wan3' || !H3_FL2VA_SEGS.has(segId)) {
                try {
                  await extractLastFrame(result.path, actualLastFramePath);
                  prevActualLastFrame = actualLastFramePath;
                } catch (e) {
                  send('seg:warn', {
                    chain: chainName,
                    seg: segId,
                    warning: `尾帧抽取失败，下一段若声明继承会退回设计首帧：${(e as Error).message}`,
                  });
                  prevActualLastFrame = null;
                }
              } else {
                prevActualLastFrame = null;
              }
            } catch (e) {
              send('seg:fail', { chain: chainName, seg: segId, error: (e as Error).message });
              prevActualLastFrame = null;
            }
          }
        }

        send('done');
        controller.close();
      } catch (e) {
        send('seg:fail', { chain: '', seg: '', error: String(e) });
        send('done');
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    },
  });
}
