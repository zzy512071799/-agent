/**
 * 返回某集所有镜段的配置（prompt + 图片依赖），供前端预览页使用。
 * GET /api/segments?work=下山只想躺平&episode=ep01
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { NextRequest } from 'next/server';
import { declaredEpisodeDir, listImageNames, resolveEpisodeDir } from '@/core/work';
import { buildWan3ReferencePlan } from '@/core/pipeline/wan3-media';

const WORKS_ROOT = resolve(process.cwd(), 'storage/works');

// 链定义读取：优先从 project.json 的 sceneShotRanges 推断，回退到 script.json
function buildChains(projectJson: Record<string, unknown> | null, epId: string): Record<string, string[]> {
  if (projectJson) {
    const eps = (projectJson.episodes as Array<Record<string, unknown>>) ?? [];
    const epNum = parseInt(epId.replace('ep', ''), 10);
    const epDef = eps.find((e) => e.episode === epNum);
    if (epDef?.sceneShotRanges) {
      const ranges = epDef.sceneShotRanges as Record<string, string[]>;
      const chains: Record<string, string[]> = {};
      for (const [scene, shots] of Object.entries(ranges)) {
        chains[scene] = shots;
      }
      return chains;
    }
  }
  // 回退：从 shots 数组按 sceneId 分组
  return {};
}

/** 从 epNN_prompts.md 解析每段的 prompt 文本（旧约定，H3 时期的存法） */
function parsePrompts(promptPath: string): Record<string, string> {
  if (!existsSync(promptPath)) return {};
  const text = readFileSync(promptPath, 'utf8');
  const out: Record<string, string> = {};
  const parts = text.split(/\n## (S\d+) — /);
  for (let i = 1; i < parts.length; i += 2) {
    const segId = parts[i];
    const body = parts[i + 1] ?? '';
    const m = body.match(/```text\n([\s\S]*?)```/);
    if (m) out[segId] = m[1].trim();
  }
  return out;
}

/**
 * 从 script.json 的 shots[].wan3Prompt 取提示词。
 *
 * wan3 时期提示词正文的唯一真相在 script.json 里，md 只留公式选型与参数说明，
 * 免得同一段 prompt 在两处各存一份、改一处忘另一处。段号用 segmentId，没有就用
 * shot id（s01 → S01）。
 */
function promptsFromScript(shots: Array<Record<string, unknown>>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const s of shots) {
    const p = s.wan3Prompt;
    if (typeof p !== 'string' || p.trim() === '') continue;
    const segId = (s.segmentId as string) ?? String(s.id ?? '').toUpperCase();
    if (segId) out[segId] = p.trim();
  }
  return out;
}

/** 首帧/尾帧的文件名判定。新项目用中文命名（S01-首帧.png），老项目是 first/last。 */
const isFirstFrame = (name: string) => name.includes('first') || name.includes('首帧');
const isLastFrame = (name: string) => name.includes('last') || name.includes('尾帧');

/** 列出某段用到的关键帧图片 */
function segImages(segId: string, shots: unknown[]): string[] {
  const imgs: string[] = [];
  for (const shot of shots as Array<Record<string, unknown>>) {
    if ((shot.segmentId as string) !== segId && shot.sceneId !== segId) continue;
    if (shot.firstFramePath) imgs.push(String(shot.firstFramePath).split('/').pop()!);
    if (shot.lastFramePath) imgs.push(String(shot.lastFramePath).split('/').pop()!);
  }
  return [...new Set(imgs)];
}

/** 列出角色卡和场景卡（参考图）*/
function refImages(script: Record<string, unknown>): string[] {
  const imgs = new Set<string>();
  const chars = (script.characters as Array<Record<string, unknown>>) ?? [];
  const scenes = (script.scenes as Array<Record<string, unknown>>) ?? [];
  for (const c of chars) {
    if (c.refImagePath) imgs.add(String(c.refImagePath).split('/').pop()!);
  }
  for (const s of scenes) {
    if (s.refImagePath) imgs.add(String(s.refImagePath).split('/').pop()!);
  }
  return [...imgs];
}

function shotReferenceImages(shot: Record<string, unknown>, script: Record<string, unknown>): string[] {
  const explicit = pathList(shot.wan3ReferencePaths);
  if (explicit.length > 0) return [...new Set(explicit)];
  const paths: string[] = [];
  const chars = (script.characters as Array<Record<string, unknown>>) ?? [];
  const scenes = (script.scenes as Array<Record<string, unknown>>) ?? [];
  for (const id of Array.isArray(shot.characterIds) ? shot.characterIds : []) {
    const character = chars.find((item) => item.id === id);
    if (typeof character?.refImagePath === 'string') paths.push(basename(character.refImagePath));
  }
  const scene = scenes.find((item) => item.id === shot.sceneId);
  if (typeof scene?.refImagePath === 'string') paths.push(basename(scene.refImagePath));
  paths.push(...pathList(shot.propPaths), ...pathList(shot.compositionPaths));
  return [...new Set(paths)];
}

const basename = (p: unknown) => String(p).split('/').pop()!;
const previewUrl = (workId: string, epId: string, name: string) =>
  `/api/images/${encodeURIComponent(workId)}/${encodeURIComponent(epId)}/${encodeURIComponent(name)}`;

function refImageIssues(script: Record<string, unknown>): Map<string, string> {
  const issues = new Map<string, string>();
  for (const group of ['characters', 'scenes']) {
    const entries = (script[group] as Array<Record<string, unknown>>) ?? [];
    for (const entry of entries) {
      const path = entry.refImagePath;
      const review = entry.refImageReview as Record<string, unknown> | undefined;
      if (!path || review?.status !== 'mismatch') continue;
      const name = basename(path);
      const note = typeof review.note === 'string' && review.note ? review.note : '图片内容与命名不一致';
      issues.set(name, note);
    }
  }
  return issues;
}

/** 取字段里的路径数组，非数组或空数组都返回 [] */
function pathList(v: unknown): string[] {
  return Array.isArray(v) ? v.map(basename) : [];
}

/** 从 project.json 的 assets 清单收集所有图片文件，供页面素材总览使用。 */
function imagePathsIn(value: unknown): string[] {
  if (typeof value === 'string' && /\.(png|jpe?g|webp)$/i.test(value)) return [basename(value)];
  if (Array.isArray(value)) return value.flatMap(imagePathsIn);
  if (value && typeof value === 'object') {
    return Object.values(value as Record<string, unknown>).flatMap(imagePathsIn);
  }
  return [];
}

export async function GET(req: NextRequest) {
  const workId = req.nextUrl.searchParams.get('work');
  const epId = req.nextUrl.searchParams.get('episode') ?? 'ep01';

  if (!workId) {
    return Response.json({ error: '缺少 work 参数' }, { status: 400 });
  }

  const workDir = join(WORKS_ROOT, workId);
  if (!existsSync(workDir)) {
    return Response.json({ error: `作品不存在: ${workId}` }, { status: 404 });
  }

  // 读 project.json（可选）
  const projectPath = join(workDir, 'project.json');
  let projectJson: Record<string, unknown> | null = null;
  if (existsSync(projectPath)) {
    try {
      const parsed = JSON.parse(readFileSync(projectPath, 'utf8'));
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        return Response.json({ error: 'project.json 格式无效' }, { status: 422 });
      }
      projectJson = parsed as Record<string, unknown>;
    } catch {
      return Response.json({ error: 'project.json 不是有效 JSON' }, { status: 422 });
    }
  }

  const epDir = resolveEpisodeDir(workDir, epId, declaredEpisodeDir(projectJson, epId));
  const scriptPath = join(epDir, 'script.json');

  if (!existsSync(scriptPath)) {
    return Response.json(
      { error: `script.json 不存在: ${scriptPath}` },
      { status: 404 },
    );
  }

  const IMAGES_DIR = join(epDir, 'media/images');
  const VIDEOS_DIR = join(epDir, 'media/videos');
  const promptPath = join(epDir, `${epId}_prompts.md`);

  let raw: Record<string, unknown>;
  try {
    const parsed = JSON.parse(readFileSync(scriptPath, 'utf8'));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return Response.json({ error: 'script.json 格式无效' }, { status: 422 });
    }
    raw = parsed as Record<string, unknown>;
  } catch {
    return Response.json({ error: 'script.json 不是有效 JSON' }, { status: 422 });
  }
  const script = raw.script as Record<string, unknown> | undefined;
  const shots = raw.shots;
  if (!script || typeof script !== 'object' || Array.isArray(script) || !Array.isArray(shots)) {
    return Response.json({ error: 'script.json 格式无效：缺少 script 对象或 shots 数组' }, { status: 422 });
  }
  // script.json 里的 wan3Prompt 优先；没有才回退到旧的 md
  const prompts = {
    ...parsePrompts(promptPath),
    ...promptsFromScript(shots as Array<Record<string, unknown>>),
  };

  // 已有视频
  const existingVideos = new Set(
    existsSync(VIDEOS_DIR)
      ? readdirSync(VIDEOS_DIR)
          .filter((f) => f.endsWith('.mp4') && !f.includes('_last_actual'))
          .map((f) => f.replace('.mp4', ''))
      : [],
  );

  // 已有尾帧
  const existingActualLastFrames = new Set(
    existsSync(VIDEOS_DIR)
      ? readdirSync(VIDEOS_DIR)
          .filter((f) => f.endsWith('_last_actual.png'))
          .map((f) => f.replace('_last_actual.png', ''))
      : [],
  );

  // 所有可用图片。新项目按用途分了子目录（角色/场景/道具/分镜），必须递归。
  const allImages = new Set(listImageNames(IMAGES_DIR));
  const imageExists = (name: string) =>
    allImages.has(name) || (name.endsWith('_last_actual.png') && existingActualLastFrames.has(name.replace('_last_actual.png', '')));

  const globalRefs = refImages(script);
  const refIssues = refImageIssues(script);

  // 构建链定义（从 project.json 读 sceneShotRanges，或从 shots 分组）
  const chains = buildChains(projectJson, epId);
  let chainMap: [string, string[]][];
  if (Object.keys(chains).length > 0) {
    chainMap = Object.entries(chains);
  } else {
    // 没有显式链定义时，优先保留 script.json 的镜头顺序；同一 sceneId 只用于旧项目分组。
    const shotList = shots as Array<Record<string, unknown>>;
    const orderedIds = shotList
      .map((shot) => (shot.segmentId ?? shot.sceneId) as string)
      .filter(Boolean);
    const isOrderedReCut = orderedIds.every((id) => /^C\d+$/.test(id));
    if (isOrderedReCut) {
      chainMap = [[`${epId}-recut`, [...new Set(orderedIds)]]];
    } else {
      const seen = new Map<string, string[]>();
      for (const shot of shotList) {
        const sid = (shot.segmentId ?? shot.sceneId) as string;
        if (!sid) continue;
        const sceneId = (shot.sceneId ?? shot.segmentId) as string;
        if (!seen.has(sceneId)) seen.set(sceneId, []);
        if (!seen.get(sceneId)!.includes(sid)) seen.get(sceneId)!.push(sid);
      }
      chainMap = [...seen.entries()];
    }
  }

  const segToChain: Record<string, string> = {};
  for (const [chainName, segIds] of chainMap) {
    for (const s of segIds) segToChain[s] = chainName;
  }

  const segments = chainMap.flatMap(([chainName, segIds]) =>
    segIds.map((segId, idx) => {
      const prompt = prompts[segId] ?? '';
      const segImgs = segImages(segId, shots);

      // 模式：script.json 里写了 wan3Mode 就用它，那是人定的、也是唯一会被 API
      // 真正采用的值；没写才从有没有首尾帧去猜（旧项目的 H3 命名）。
      const shotDef = (shots as Array<Record<string, unknown>>).find(
        (s) => s.segmentId === segId || String(s.id ?? '').toUpperCase() === segId,
      );
      const declaredMode = shotDef?.wan3Mode as string | undefined;

      const hasFirst = segImgs.some(isFirstFrame);
      const hasLast = segImgs.some(isLastFrame);
      const mode =
        declaredMode ?? (hasFirst && hasLast ? 'FL2VA' : hasFirst ? 'I2VA' : hasLast ? 'L2VA' : 'T2VA');

      // 参考图：`wan3ReferencePaths` 是有序的，提示词里的「图1/图2」按这个顺序指代，
      // 所以必须原样带序号给前端——否则核对时根本看不出图号对应哪张。
      // 没声明才回退到「所有角色卡+场景卡」（H3 时期的旧行为）；wan3 的首帧/首尾帧段
      // 压根不吃参考图，不该把三十张卡全铺出来。
      const prevSegId = idx > 0 ? segIds[idx - 1] : null;
      const inheritedSegment = shotDef?.wan3FirstFrameFrom as string | undefined;
      const declaredContinuityName =
        declaredMode === 'reference' && inheritedSegment
          ? `${inheritedSegment}_last_actual.png`
          : null;
      const continuityName = declaredContinuityName && imageExists(declaredContinuityName)
        ? declaredContinuityName
        : null;
      const declaredRefs =
        declaredMode === 'reference'
          ? shotReferenceImages(shotDef ?? {}, script)
          : pathList(shotDef?.wan3ReferencePaths);
      const orderedRefs = continuityName ? [continuityName, ...declaredRefs] : declaredRefs;
      const refs =
        orderedRefs.length > 0
          ? orderedRefs.map((name, i) => ({
              index: i + 1,
              token: `@图片${i + 1}`,
              name,
              path: name,
              role: 'reference_image' as const,
              label: `图${i + 1}`,
              exists: imageExists(name),
              previewUrl: previewUrl(workId, epId, name),
              uploadable: imageExists(name) && !refIssues.has(name),
              ...(refIssues.has(name) ? { issue: refIssues.get(name) } : {}),
            }))
          : declaredMode === undefined
            ? globalRefs
                .filter((name) => allImages.has(name))
                .map((name) => ({
                  index: 0,
                  token: '',
                  name,
                  path: name,
                  role: 'reference_image' as const,
                  label: '',
                  exists: true,
                  previewUrl: previewUrl(workId, epId, name),
                  uploadable: !refIssues.has(name),
                  ...(refIssues.has(name) ? { issue: refIssues.get(name) } : {}),
                }))
            : [];

      // 显式首帧模式不会把角色卡/场景卡上传到视频 API，但这些素材仍需在控制台可见，
      // 供人工核对和制作首帧使用。已经声明为 API 参考图的文件不重复展示。
      const shownReferenceNames = new Set(refs.map((item) => item.name));
      const visualRefs =
        declaredMode !== undefined
          ? globalRefs
              .filter((name) => !shownReferenceNames.has(name) && allImages.has(name))
              .map((name) => ({
                index: 0,
                token: '',
                name,
                path: name,
                role: 'visual_reference' as const,
                label: '',
                exists: true,
                previewUrl: previewUrl(workId, epId, name),
                uploadable: false,
                ...(refIssues.has(name) ? { issue: refIssues.get(name) } : {}),
              }))
          : [];

      const annotatedPrompt = buildWan3ReferencePlan(prompt, orderedRefs, continuityName).prompt;
      const deps = [
        ...segImgs.map((name, frameIndex) => ({
          index: frameIndex + 1,
          token: `@图片${frameIndex + 1}`,
          name,
          path: name,
          role: isLastFrame(name) ? 'last_frame' : 'first_frame',
          label: '',
          exists: allImages.has(name),
          previewUrl: previewUrl(workId, epId, name),
          uploadable: allImages.has(name),
        })),
        ...refs,
        ...visualRefs,
      ];
      const alreadyShown = new Set(deps.map((d) => d.name));

      // 首帧源素材与道具卡都**不是**当前视频 API 入参：它们用于制作/核对首帧，
      // 必须单独展示，避免用户看不见依赖链，也避免误以为要和 first_frame 一起上传。
      // 但核对时要看得见，所以单独标一类，前端分组显示并注明。已经作为参考图进过
      // API 的（S05 的档案-11）不再重复列一遍，否则看上去像要传两次。
      for (const name of pathList(shotDef?.propPaths)) {
        if (alreadyShown.has(name)) continue;
        alreadyShown.add(name);
        deps.push({
          index: 0,
          token: '',
          name,
          path: name,
          role: 'prop',
          label: '',
          exists: allImages.has(name),
          previewUrl: previewUrl(workId, epId, name),
          uploadable: false,
        });
      }
      for (const name of pathList(shotDef?.frameSourcePaths)) {
        if (alreadyShown.has(name)) continue;
        alreadyShown.add(name);
        deps.push({
          index: 0,
          token: '',
          name,
          path: name,
          role: 'source',
          label: '',
          exists: allImages.has(name),
          previewUrl: previewUrl(workId, epId, name),
          uploadable: false,
        });
      }
      if (shotDef?.compositionRefPath) {
        const name = basename(shotDef.compositionRefPath);
        if (!alreadyShown.has(name)) {
          deps.push({
            index: 0,
            token: '',
            name,
            path: name,
            role: 'composition',
            label: '',
            exists: allImages.has(name),
            previewUrl: previewUrl(workId, epId, name),
            uploadable: false,
          });
        }
      }

      return {
        segId,
        chainName,
        chainIdx: idx,
        mode,
        durationSec: Number(shotDef?.durationSec) || 0,
        prompt: annotatedPrompt,
        note: typeof shotDef?.note === 'string' ? shotDef.note : '',
        // 声明了 wan3FirstFrameFrom 才是链内段（首帧继承上一段的真实尾帧）；
        // 没声明的段即使前面有段，也一律用自己定稿的首帧。
        inheritFrom: (shotDef?.wan3FirstFrameFrom as string | undefined) ?? null,
        requiresVoiceRef: shotDef?.requiresVoiceRef === true,
        hasVoiceRef: pathList(shotDef?.wan3ReferenceAudioUrls).length > 0,
        deps,
        hasVideo: existingVideos.has(segId),
        // 已经出过片的段要把绝对路径带回去，页面刷新后才能继续预览——
        // 否则视频只在生成当次的 SSE 里出现一次，刷一下就看不见了。
        videoPath: existingVideos.has(segId) ? join(VIDEOS_DIR, `${segId}.mp4`) : null,
        hasActualLastFrame: existingActualLastFrames.has(segId),
        prevSegId,
        prevHasActualLastFrame: prevSegId ? existingActualLastFrames.has(prevSegId) : false,
      };
    }),
  );

  type AssetDep = {
    name: string;
    role: string;
    label: string;
    exists: boolean;
    issue?: string;
  };
  const assetMap = new Map<string, AssetDep>();
  for (const dep of segments.flatMap((segment) => segment.deps)) {
    assetMap.set(dep.name, dep);
  }
  // 依赖之外的角色三视图、侧/背面单视图和战略路线图也必须在页面总览出现。
  for (const name of imagePathsIn(projectJson?.assets)) {
    if (!assetMap.has(name)) {
      assetMap.set(name, {
        name,
        role: 'reference_image',
        label: '',
        exists: allImages.has(name),
        ...(refIssues.has(name) ? { issue: refIssues.get(name) } : {}),
      });
    }
  }
  const assetCatalog = [...assetMap.values()];
  const requiredFrames = segments
    .flatMap((segment) => segment.deps)
    .filter((dep) => dep.role === 'first_frame' || dep.role === 'last_frame');
  const missingFrames = requiredFrames.filter((dep) => !dep.exists).map((dep) => dep.name);
  const reviewedIssues = assetCatalog.filter((asset) => asset.issue).map((asset) => ({
    name: asset.name,
    issue: asset.issue,
  }));
  const missingReferenceImages = assetCatalog
    .filter((asset) => asset.role === 'reference_image' && !asset.exists)
    .map((asset) => asset.name);
  const assetSummary = {
    status: missingFrames.length === 0 && missingReferenceImages.length === 0 && reviewedIssues.length === 0
      ? 'ready'
      : 'incomplete',
    staticImages: allImages.size,
    requiredFrames: { present: requiredFrames.length - missingFrames.length, total: requiredFrames.length },
    missingFrames: [...new Set(missingFrames)],
    missingReferenceImages: [...new Set(missingReferenceImages)],
    issues: reviewedIssues,
  };

  return Response.json({
    workId,
    epId,
    epDir: relative(process.cwd(), epDir),
    segments,
    assetCatalog,
    assetSummary,
    allImages: [...allImages],
    totalShots: shots.length,
  });
}
