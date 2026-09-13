import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { NextRequest } from 'next/server';
import { declaredEpisodeDir, resolveEpisodeDir } from '@/core/work';

const WORKS_ROOT = resolve(process.cwd(), 'storage/works');

const basename = (value: string) => value.split('/').pop() ?? value;

export async function GET(req: NextRequest) {
  const workId = req.nextUrl.searchParams.get('work');
  const epId = req.nextUrl.searchParams.get('episode') ?? 'ep01';
  if (!workId) return Response.json({ error: '缺少 work 参数' }, { status: 400 });

  const workDir = join(WORKS_ROOT, workId);
  const projectPath = join(workDir, 'project.json');
  if (!existsSync(workDir)) return Response.json({ error: `作品不存在: ${workId}` }, { status: 404 });

  let project: Record<string, unknown> | null = null;
  if (existsSync(projectPath)) {
    try { project = JSON.parse(readFileSync(projectPath, 'utf8')) as Record<string, unknown>; }
    catch { return Response.json({ error: 'project.json 不是有效 JSON' }, { status: 422 }); }
  }

  const epDir = resolveEpisodeDir(workDir, epId, declaredEpisodeDir(project, epId));
  const probesPath = join(epDir, 'probes.json');
  if (!existsSync(probesPath)) return Response.json({ error: `probes.json 不存在: ${probesPath}` }, { status: 404 });

  let raw: Record<string, unknown>;
  try { raw = JSON.parse(readFileSync(probesPath, 'utf8')) as Record<string, unknown>; }
  catch { return Response.json({ error: 'probes.json 不是有效 JSON' }, { status: 422 }); }

  const probes = Array.isArray(raw.probes) ? raw.probes : [];
  const result = probes.flatMap((value) => {
    if (!value || typeof value !== 'object') return [];
    const probe = value as Record<string, unknown>;
    const refs = Array.isArray(probe.wan3ReferencePaths) ? probe.wan3ReferencePaths.map(String) : [];
    const prompt = typeof probe.prompt === 'string' ? probe.prompt : '';
    const tokens = [...prompt.matchAll(/@图片(\d+)/g)].map((match) => Number(match[1]));
    return [{
      id: String(probe.id ?? ''),
      name: String(probe.name ?? probe.id ?? ''),
      durationSec: Number(probe.durationSec) || 0,
      mode: String(probe.wan3Mode ?? 'reference'),
      prompt,
      endState: String(probe.endState ?? ''),
      refs: refs.map((ref, index) => ({
        index: index + 1,
        token: `@图片${index + 1}`,
        name: basename(ref),
        path: ref,
        previewUrl: `/api/images/${encodeURIComponent(workId)}/${encodeURIComponent(epId)}/${encodeURIComponent(ref.replace(/^.*\/media\/images\//, ''))}`,
        exists: true,
      })),
      tokenValid: tokens.every((token) => token >= 1 && token <= refs.length),
    }];
  });

  return Response.json({
    workId,
    epId,
    production: raw.production ?? 'probe-only',
    requiresUserConfirmationForGeneration: raw.requiresUserConfirmationForGeneration !== false,
    probes: result,
  });
}
