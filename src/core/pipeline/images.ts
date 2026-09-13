import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { Character, Scene, Script, Shot } from '../schema';
import type { ImageProvider } from '../providers/types';
import { TIME_OF_DAY_PROMPT } from './storyboard';

/**
 * 分镜图生成。
 *
 * 两步走，顺序不能颠倒：
 * 1. 先给每个角色出一张参考图（文生图，正面全身、白底）
 * 2. 再逐镜出图，把参考图作为 --input 传进去走图生图
 *
 * 第 2 步依赖第 1 步的产物，这是角色跨镜一致性的来源。直接文生图每镜都会
 * 画出不同的脸，哪怕 appearance 文本完全一样。
 */

/** 参考图专用 prompt：四视图角色卡。 */
function buildRefPrompt(character: Character, artStyle: string): string {
  return [
    artStyle,
    // 四视图而非单张正面：图生图时模型只见过正脸，遇到侧身背身的分镜就会自己编，
    // 脸型和发型最容易在这种镜头上漂。四视图把各角度信息一次给全。
    'character reference sheet, four views of the SAME character in one image, left to right',
    'large portrait close-up, full-body front view, full-body side view, full-body back view',
    'identical face, hairstyle and outfit across all four views',
    'plain white background, even lighting, no props, no text',
    character.appearance,
  ]
    .map((part) => part.trim().replace(/[.。]+$/, ''))
    .join('. ');
}

/** 场景参考图 prompt：只要环境，不要人。 */
function buildSceneRefPrompt(scene: Scene, artStyle: string): string {
  return [
    artStyle,
    'establishing shot of an empty environment, no people, no characters',
    `location: ${scene.location}`,
    TIME_OF_DAY_PROMPT[scene.timeOfDay],
  ]
    .map((part) => part.trim().replace(/[.。]+$/, ''))
    .join('. ');
}

/**
 * 并发跑任务，限制同时在飞的数量。
 *
 * 单个任务失败不拖垮整批：图片接口偶发超时/限流是常态，24 张图里挂 1 张
 * 就整批重来太贵。失败的位置返回 null，由调用方决定重试还是跳过。
 */
async function mapLimit<T, R>(
  items: T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<Array<R | null>> {
  const results: Array<R | null> = new Array(items.length).fill(null);
  const errors: Array<{ index: number; message: string }> = [];
  let cursor = 0;

  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) {
      const i = cursor++;
      try {
        results[i] = await fn(items[i], i);
      } catch (e) {
        errors.push({ index: i, message: (e as Error).message });
      }
    }
  });

  await Promise.all(workers);

  if (errors.length > 0) {
    console.warn(`  ⚠️ ${errors.length}/${items.length} 个任务失败：`);
    for (const e of errors.slice(0, 5)) console.warn(`     #${e.index} ${e.message}`);
    if (errors.length > 5) console.warn(`     ...还有 ${errors.length - 5} 个`);
  }

  return results;
}

/**
 * 生成角色参考图，返回带 refImagePath 的角色副本。
 *
 * 参考图用 1:1 而不是剧本的 9:16 —— 角色卡只需要人物本身，方形能少浪费像素。
 * 已有产物直接复用：参考图是一致性锚点，重出一张就等于换了个人，
 * 后面所有引用它的分镜图都会跟着漂。
 */
export async function generateCharacterRefs(
  script: Script,
  image: ImageProvider,
  concurrency = 4,
  imagesDir?: string,
): Promise<Character[]> {
  const results = await mapLimit(script.characters, concurrency, async (character) => {
    const filename = `char-${character.id}.png`;
    const existing = imagesDir ? join(imagesDir, filename) : null;
    if (existing && existsSync(existing)) return { ...character, refImagePath: existing };

    const { path } = await image.generate({
      prompt: buildRefPrompt(character, script.artStyle),
      aspectRatio: '1:1',
      filename,
    });
    return { ...character, refImagePath: path };
  });

  // 失败的角色保留原始记录（refImagePath 为 null），下游会退化成纯文生图
  return results.map((r, i) => r ?? script.characters[i]);
}

/**
 * 生成场景参考图，返回带 refImagePath 的场景副本。
 *
 * 用 16:9 出图：环境图是横向信息更多的，而且它只当参考图用，不直接进片。
 */
export async function generateSceneRefs(
  script: Script,
  image: ImageProvider,
  concurrency = 4,
  imagesDir?: string,
): Promise<Scene[]> {
  const results = await mapLimit(script.scenes, concurrency, async (scene) => {
    const filename = `scene-${scene.id}.png`;
    const existing = imagesDir ? join(imagesDir, filename) : null;
    if (existing && existsSync(existing)) return { ...scene, refImagePath: existing };

    const { path } = await image.generate({
      prompt: buildSceneRefPrompt(scene, script.artStyle),
      aspectRatio: '16:9',
      filename,
    });
    return { ...scene, refImagePath: path };
  });

  return results.map((r, i) => r ?? script.scenes[i]);
}

export interface ShotImage {
  shotId: string;
  path: string;
  /** 重 roll 时递增，旧版本不删，方便人工挑。 */
  version: number;
  /** 实际用到的参考图，出问题时用来判断是不是一致性锚点没传上。 */
  refImagePaths: string[];
  /** 服务端实际输出尺寸。接口不保证按请求比例出图，必须记录真实值。 */
  size?: string;
}

/**
 * 逐镜出图。
 *
 * characters / scenes 必须是 generateCharacterRefs / generateSceneRefs 的返回值
 * （带 refImagePath），传原始 script.characters 会退化成纯文生图，一致性就没了。
 *
 * 参考图顺序：场景在前、角色在后。角色一致性比环境一致性更容易被观众察觉，
 * 放在后面更靠近文本指令，权重上更受重视。
 *
 * imagesDir 传了就跳过已有产物，中途挂掉重跑不重烧。
 */
export async function generateShotImages(
  shots: Shot[],
  script: Script,
  characters: Character[],
  scenes: Scene[],
  image: ImageProvider,
  opts: { concurrency?: number; version?: number; imagesDir?: string } = {},
): Promise<ShotImage[]> {
  const version = opts.version ?? 1;
  const refByCharacter = new Map(characters.map((c) => [c.id, c.refImagePath]));
  const refByScene = new Map(scenes.map((s) => [s.id, s.refImagePath]));

  const results: Array<ShotImage | null> = await mapLimit(shots, opts.concurrency ?? 4, async (shot): Promise<ShotImage | null> => {
    const sceneRef = refByScene.get(shot.sceneId);
    const refImagePaths = [
      ...(sceneRef ? [sceneRef] : []),
      ...shot.characterIds
        .map((id) => refByCharacter.get(id))
        .filter((p): p is string => Boolean(p)),
    ];

    const filename = `${shot.id}-v${version}.png`;
    const existing = opts.imagesDir ? join(opts.imagesDir, filename) : null;
    if (existing && existsSync(existing)) {
      return { shotId: shot.id, path: existing, version, refImagePaths };
    }

    const { path, size } = await image.generate({
      prompt: shot.imagePrompt,
      negativePrompt: shot.negativePrompt,
      aspectRatio: script.aspectRatio,
      refImagePaths,
      filename,
    });

    return { shotId: shot.id, path, version, refImagePaths, size };
  });

  // 失败的镜头直接不返回，调用方按数量差就知道缺了几张，重跑会补上
  return results.filter((r): r is ShotImage => r !== null);
}
