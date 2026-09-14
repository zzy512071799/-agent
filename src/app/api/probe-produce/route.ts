import { existsSync, readFileSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { isAbsolute, join, resolve } from 'node:path';
import { NextRequest } from 'next/server';
import { createWan3Provider, type Wan3MediaItem } from '@/core/providers/wan3';

const WORKS = resolve(process.cwd(), 'storage/works');
const ALLOWED_PROBES = new Set(['P01', 'P02', 'P03']);

type Probe = {
  id: string;
  name?: string;
  durationSec: number;
  wan3Mode: string;
  wan3ReferencePaths: string[];
  prompt: string;
};

function resolveAsset(workDir: string, value: string): string {
  const candidate = isAbsolute(value) || value.startsWith('storage/works/')
    ? resolve(process.cwd(), value)
    : resolve(workDir, value);
  if (candidate !== WORKS && !candidate.startsWith(`${WORKS}/`)) {
    throw new Error(`素材路径超出作品目录：${value}`);
  }
  return candidate;
}

function validateProbe(raw: unknown, workDir: string): Probe {
  if (!raw || typeof raw !== 'object') throw new Error('探针配置不是对象');
  const probe = raw as Partial<Probe>;
  if (typeof probe.id !== 'string' || !ALLOWED_PROBES.has(probe.id)) {
    throw new Error(`只允许生成 P01/P02/P03，收到：${String(probe.id)}`);
  }
  if (typeof probe.prompt !== 'string' || !probe.prompt.trim()) throw new Error(`${probe.id} 缺少 prompt`);
  if (probe.wan3Mode !== 'reference') throw new Error(`${probe.id} 只支持 reference 模式`);
  if (!Number.isInteger(probe.durationSec) || probe.durationSec < 2 || probe.durationSec > 30) {
    throw new Error(`${probe.id} 时长必须是 2-30 秒整数`);
  }
  if (!Array.isArray(probe.wan3ReferencePaths) || probe.wan3ReferencePaths.length === 0) {
    throw new Error(`${probe.id} 缺少参考图`);
  }
  const refs = probe.wan3ReferencePaths;
  for (const ref of refs) {
    if (typeof ref !== 'string' || !existsSync(resolveAsset(workDir, ref))) {
      throw new Error(`${probe.id} 参考图不存在：${String(ref)}`);
    }
  }
  const tokens = [...probe.prompt.matchAll(/@图片(\d+)/g)].map((m) => Number(m[1]));
  const expected = refs.map((_, index) => index + 1);
  if (tokens.length === 0 || tokens.some((token) => !expected.includes(token))) {
    throw new Error(`${probe.id} 图片引用必须使用 @图片1-${expected.length}`);
  }
  return { ...probe, id: probe.id, durationSec: probe.durationSec, wan3Mode: probe.wan3Mode, wan3ReferencePaths: refs, prompt: probe.prompt };
}

export async function GET(req: NextRequest) {
  const workId = req.nextUrl.searchParams.get('work');
  const episodeDir = req.nextUrl.searchParams.get('episodeDir');
  const probeId = req.nextUrl.searchParams.get('probe');
  const dryRun = req.nextUrl.searchParams.get('dry') === '1';
  const resolution = req.nextUrl.searchParams.get('resolution') === '1080P' ? '1080P' : req.nextUrl.searchParams.get('resolution') === '720P' ? '720P' : '480P';

  if (!workId || !episodeDir || !probeId) return Response.json({ error: '缺少 work、episodeDir 或 probe 参数' }, { status: 400 });
  if (!ALLOWED_PROBES.has(probeId)) return Response.json({ error: `只允许 P01/P02/P03，收到：${probeId}` }, { status: 400 });

  try {
    const workDir = join(WORKS, workId);
    const probePath = join(workDir, episodeDir, 'probes.json');
    if (!existsSync(probePath)) return Response.json({ error: `probes.json 不存在: ${probePath}` }, { status: 404 });
    const config = JSON.parse(readFileSync(probePath, 'utf8')) as { aspectRatio?: string; probes?: unknown[] };
    const probe = validateProbe(config.probes?.find((item) => (item as { id?: string })?.id === probeId), workDir);
    const outputDir = join(workDir, episodeDir, 'media/probes');
    const outPath = join(outputDir, `${probe.id}.mp4`);
    const media: Wan3MediaItem[] = probe.wan3ReferencePaths.map((path) => ({ type: 'reference_image', url: resolveAsset(workDir, path) }));
    const result = { probe: probe.id, name: probe.name, mode: probe.wan3Mode, durationSec: probe.durationSec, resolution, media: media.map((item) => item.url), outPath };
    if (dryRun) return Response.json({ ...result, status: 'validated', prompt: probe.prompt });

    await mkdir(outputDir, { recursive: true });
    const taskEvents: string[] = [];
    const provider = createWan3Provider();
    const generated = await provider.generate({ prompt: probe.prompt, media, resolution, ratio: config.aspectRatio === '16:9' ? '16:9' : '9:16', durationSec: probe.durationSec, audio: true, promptExtend: false, model: 'standard', outPath, onTaskCreated: (taskId) => taskEvents.push(taskId) });
    return Response.json({ ...result, status: 'succeeded', taskIds: taskEvents, path: generated.path, taskId: generated.taskId, elapsedSec: generated.elapsedSec });
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : String(error) }, { status: 500 });
  }
}
