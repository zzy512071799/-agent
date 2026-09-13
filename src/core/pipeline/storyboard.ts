import {
  Script,
  Shot,
  ShotDraft,
  ShotSize,
  type Character,
  type Scene,
} from '../schema';
import { z } from 'zod';
import { oneApiLlm } from '../providers/llm';

/** 并发跑，单个失败不拖垮整批。失败位置返回 null。 */
async function mapLimit<T, R>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<Array<R | null>> {
  const results: Array<R | null> = new Array(items.length).fill(null);
  let cursor = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (cursor < items.length) {
        const i = cursor++;
        try {
          results[i] = await fn(items[i]);
        } catch (e) {
          console.warn(`⚠️ 第 ${i + 1} 段分镜失败：${(e as Error).message}`);
        }
      }
    }),
  );
  return results;
}

/**
 * 剧本 → 分镜。
 *
 * 分工：LLM 只负责"怎么拆"（景别、动作、台词、时长），imagePrompt 由本文件
 * 用模板拼。让 LLM 直接写 prompt 试过一次就知道不行 —— 它会写"林澈站在书架前"
 * 这种带角色名的描述，图片模型不认识林澈，形象每镜都会漂。
 */

/** 景别 → 图片模型能理解的构图描述。 */
const SHOT_SIZE_PROMPT: Record<ShotSize, string> = {
  'extreme-wide': 'extreme wide establishing shot, tiny figures in vast environment',
  wide: 'wide full-body shot, entire figure visible',
  medium: 'medium shot, waist up',
  'close-up': 'close-up portrait, shoulders and face',
  'extreme-close-up': 'extreme close-up macro detail',
};

export const TIME_OF_DAY_PROMPT: Record<Scene['timeOfDay'], string> = {
  dawn: 'soft pale dawn light, low sun',
  day: 'bright natural daylight',
  dusk: 'warm golden dusk light, long shadows',
  night: 'night scene, moonlight and artificial lamp light',
};

/** 漫剧图常见的坏结果，统一压掉。 */
const DEFAULT_NEGATIVE =
  'text, watermark, signature, extra limbs, deformed hands, blurry, low quality, ' +
  'multiple heads, distorted face, western cartoon style';

/**
 * 编译 Wan3 单镜头提示词。
 *
 * 约束顺序固定为“帧锁定 → 参考图 → 单镜头/对白 → 镜头参数 → 连续动作 →
 * 结束状态 → 音效”，让视频模型先锁定空间，再执行动作。时间点不作为默认
 * 结构，只有人工 Prompt 明确需要时才保留。
 */
export function buildWan3Prompt(
  shot: Pick<Shot, 'shotSize' | 'cameraMove' | 'cameraAmplitude' | 'cameraSpeed' | 'characterIds' | 'action' | 'motionPrompt' | 'lines' | 'sfx' | 'wan3EndState' | 'firstFramePath' | 'lastFramePath'>,
  characters: Character[],
  options: {
    referenceAnnotations?: string[];
    referenceAnchors?: Array<{ needle: string; annotation: string }>;
    openingLock?: string;
    endingLock?: string;
  } = {},
): string {
  const cast = shot.characterIds
    .map((id) => {
      const character = characters.find((item) => item.id === id);
      return character ? `${character.name}：${character.appearance}` : id;
    })
    .join('\n');
  const cameraMove = shot.cameraMove === 'static' ? '固定机位' : shot.cameraMove;
  const cameraTuning = [
    shot.cameraAmplitude !== 'medium' ? `幅度${shot.cameraAmplitude}` : '',
    shot.cameraSpeed !== 'normal' ? `速度${shot.cameraSpeed}` : '',
  ].filter(Boolean).join('，');
  const dialogue = shot.lines
    .map((line) => {
      const speaker = line.characterId
        ? characters.find((character) => character.id === line.characterId)?.name ?? line.characterId
        : '旁白';
      return `${speaker}（${line.emotion}）说：「${line.text}」`;
    })
    .join('；');
  const frameLock = shot.firstFramePath && shot.lastFramePath
    ? '首帧/尾帧'
    : shot.firstFramePath
      ? '首帧'
      : shot.lastFramePath
        ? '尾帧'
        : null;
  const defaultFrameLock = frameLock
    ? `${frameLock}\n锁定${options.openingLock ?? '开场构图、空间关系、人物姿态与道具位置'}${options.endingLock ? `；${options.endingLock}` : ''}，全片生效。`
    : '';
  const references = (options.referenceAnnotations ?? []).join('\n');
  const action = [shot.action, shot.motionPrompt].filter(Boolean).join('；');
  const anchoredAction = (options.referenceAnchors ?? []).reduce(
    (text, anchor) => text.split(anchor.needle).join(`${anchor.annotation}${anchor.needle}`),
    action,
  );
  const endState = shot.wan3EndState || '动作完成后保持最终人物姿态、道具位置和空间关系稳定，不新增角色或改变场景布局。';

  return [
    defaultFrameLock,
    references,
    '生成单镜头。',
    `镜头参数：${shot.shotSize}，${cameraMove}${cameraTuning ? `，${cameraTuning}` : ''}。`,
    anchoredAction ? `画面内容：${anchoredAction}` : '',
    dialogue
      ? `对白时序：在上述连续动作对应的角色出现口型和发声动作时，按出场顺序依次说出：${dialogue}。对白必须与动作同步，不提前、不延后。`
      : '无台词。',
    `人物约束：${cast}`,
    `结束状态：${endState}`,
    shot.sfx ? `音效：${shot.sfx}` : '',
  ].filter(Boolean).join('\n');
}

export function buildImagePrompt(
  shot: Pick<Shot, 'shotSize' | 'actionEn' | 'characterIds'>,
  script: Pick<Script, 'artStyle'>,
  scene: Pick<Scene, 'location' | 'timeOfDay'>,
  characters: Character[],
): string {
  const cast = shot.characterIds
    .map((id) => characters.find((c) => c.id === id))
    .filter((c): c is Character => Boolean(c))
    // 用 id 而不是 name 做标签：name 是中文，混在英文 prompt 里是纯噪声
    .map((c) => `${c.id}: ${c.appearance}`);

  return [
    script.artStyle,
    SHOT_SIZE_PROMPT[shot.shotSize],
    shot.actionEn,
    ...cast,
    `location: ${scene.location}`,
    TIME_OF_DAY_PROMPT[scene.timeOfDay],
  ]
    // 各段本身可能自带句号，去掉后统一用 '. ' 连接，避免出现 '..'
    .map((part) => part.trim().replace(/[.。]+$/, ''))
    .filter(Boolean)
    .join('. ');
}

/**
 * 交付单位：一集 = 8 个片段，每段 15 秒，合计 2 分钟。
 *
 * 为什么把它定死：一个场景就是一次视频生成任务，场景时长以前是 8-28 秒的自由值，
 * 结果每集总长随机（实测第 1 集 6 场 84 秒），既拼不出固定片长，人工上传时
 * 也数不清该传几次。定成 8×15 之后，场景 = 片段 = 一个文件 = 一次生成，
 * 三者一一对应。15 秒也在 Seedance（≤30s）和 H3（≤15s）的公共区间里。
 */
export const SEGMENT_SEC = 15;
export const SEGMENTS_PER_EPISODE = 8;

const SYSTEM = `你是漫剧分镜师。把剧本拆成可拍的分镜。

规则：
- 每个场景拆 3-5 个镜头，节奏上远景交代环境、中景推进剧情、特写给情绪
- **同一场景内所有镜头的 durationSec 之和必须等于 ${SEGMENT_SEC} 秒**（容差 ±1）。
  一个场景就是一次视频生成任务，也是交付给用户的一个片段文件，长度必须齐整。
  凑不够就加一个空镜或延长情绪镜头，超了就压时长。
- shotSize 只能用：extreme-wide / wide / medium / close-up / extreme-close-up
- cameraMove 只能用：static / zoom-in / zoom-out / push-in / pull-out / pan-left / pan-right /
  truck-left / truck-right / tilt-up / tilt-down / arc / tracking / handheld
- cameraAmplitude 用 small / medium / large，cameraSpeed 用 slow / normal / fast。
  情绪镜头用 small + slow，动作镜头用 large + fast，常规镜头留 medium + normal。
- durationSec 按台词长度估，无台词的空镜 2-3 秒，有台词的按每字 0.25 秒算
- action 写中文，actionEn 写同一个动作的英文，英文里不要出现角色名字，只描述外观和动作
- characterIds 必须用剧本里已有的角色 id
- lines 里 characterId 为 null 表示旁白
- sfx 写中文，只写这一镜特有的动作音（开门、脚步、玻璃碎、纸页翻动），
  全场持续的环境音不要写在这里。没有特别音效就留空字符串。
- motionPrompt 写中文，只描述"画面怎么动"：人物的细微动作、表情变化、环境动效（雨丝、发丝、光晕）。
  不要描述画面内容或人物外貌，也不要重复 cameraMove 已经表达的运镜。
- **sfxEn 和 motionPromptEn 是上面两个字段的英文版，必须都填**（对应字段为空时也留空）。
  视频模型 MiniMax H3 的提示词规范要求正文写英文，只有台词保留中文，
  所以这两项不是可选的装饰，缺了整段提示词就得降级用中文。
  英文写具体的可见/可听内容，不要用 cinematic、dramatic、beautiful 这类抽象词。
  **英文里一律不出现角色名（拼音也不行）**，用 the woman / the older man 指代 ——
  H3 靠 <Subject N> 标签绑定角色，出现名字会被当成一个没定义过的新实体。
- sceneIndex 必须是剧本里存在的场景 index`;

/** 单段分镜的返回结构。逐段生成，所以不需要 sceneIndex。 */
const SegmentDraft = z.object({ shots: z.array(ShotDraft) });

/**
 * 剧本 → 分镜。**逐段各调一次 LLM**，不是一次拆全集。
 *
 * 一次性拆全集试过，撞两个问题：8 段的输出太长，模型会自己缩量 —— 实测 8 段只给了
 * 11 个镜头共 38 秒，其中 2 段一个镜头都没有；而且一次调用失败整集都没有分镜。
 * 逐段调用后每次只需要输出 3-5 个镜头合计 15 秒，约束短、好遵守，某段崩了也只补那一段。
 */
export async function generateStoryboard(script: Script): Promise<Shot[]> {
  const cast = script.characters.map((c) => ({ id: c.id, name: c.name, role: c.role }));
  const knownCharacterIds = new Set(script.characters.map((c) => c.id));

  // 并发 3：段之间互不依赖，但 LLM 网关有速率限制，开太大反而整批失败
  const drafts = await mapLimit(script.scenes, 3, async (scene) => {
    const brief = {
      title: script.title,
      synopsis: script.synopsis,
      characters: cast,
      segment: {
        index: scene.index,
        title: scene.title,
        location: scene.location,
        timeOfDay: scene.timeOfDay,
        summary: scene.summary,
      },
    };

    return oneApiLlm.completeJson(
      `只给这一段拆分镜，时长必须合计 ${SEGMENT_SEC} 秒：\n${JSON.stringify(brief, null, 2)}\n\n按这个结构输出：
{"shots":[{"index":0,"durationSec":3,"shotSize":"wide","cameraMove":"static","cameraAmplitude":"medium","cameraSpeed":"normal","characterIds":[],"action":"","actionEn":"","motionPrompt":"","motionPromptEn":"","sfx":"","sfxEn":"","lines":[{"characterId":null,"text":"","emotion":"neutral"}]}]}`,
      SegmentDraft,
      { system: SYSTEM },
    );
  });

  const shots: Shot[] = [];
  for (const [i, scene] of script.scenes.entries()) {
    const draft = drafts[i];
    if (!draft) {
      console.warn(`⚠️ 片段「${scene.title}」分镜生成失败，重跑 create 会补上`);
      continue;
    }

    for (const [seq, raw] of draft.shots.entries()) {
      const shot: Shot = {
        id: `sc${scene.index}-sh${seq}`,
        sceneId: scene.id,
        index: seq,
        durationSec: raw.durationSec,
        shotSize: raw.shotSize,
        cameraMove: raw.cameraMove,
        cameraAmplitude: raw.cameraAmplitude,
        cameraSpeed: raw.cameraSpeed,
        // 编出来的角色 id 直接过滤，否则拼 prompt 时会静默丢失
        characterIds: raw.characterIds.filter((id) => knownCharacterIds.has(id)),
        action: raw.action,
        actionEn: raw.actionEn,
        motionPrompt: raw.motionPrompt,
        motionPromptEn: raw.motionPromptEn,
        sfx: raw.sfx,
        sfxEn: raw.sfxEn,
        // 空台词要滤掉：模板里给了 lines 的示例结构，LLM 照抄时会给无声镜头
        // 塞一条 text 为空的记录。留着的话 prompt 里会出现"旁白说：「」"。
        lines: raw.lines.filter((l) => l.text.trim().length > 0),
        imagePrompt: '',
        negativePrompt: DEFAULT_NEGATIVE,
        wan3Prompt: '',
      };
      shot.imagePrompt = buildImagePrompt(shot, script, scene, script.characters);
      const shotReferences = shot.characterIds
        .map((id) => script.characters.find((character) => character.id === id))
        .filter((character): character is Character => Boolean(character?.refImagePath))
        .map((character) => ({
          filename: character.refImagePath!.split('/').pop()!,
          name: character.name,
          kind: '角色',
        }));
      if (scene.refImagePath) {
        shotReferences.push({
          filename: scene.refImagePath.split('/').pop()!,
          name: scene.title,
          kind: '场景',
        });
      }
      shot.wan3Prompt = buildWan3Prompt(shot, script.characters, {
        referenceAnnotations: shotReferences.map(
          (reference, index) => `@图片${index + 1}（${reference.filename}）锁定${reference.kind}${reference.name}的身份、外形和空间关系，全片生效。`,
        ),
        referenceAnchors: shotReferences.map((reference, index) => ({
          needle: reference.name,
          annotation: `@图片${index + 1}（${reference.filename}）`,
        })),
      });
      shots.push(shot);
    }
  }

  // 片段时长是硬约束：一个场景 = 一个 15s 片段 = 一次视频生成任务。
  // 这里只报警不自动改 —— 加哪个空镜、压哪个镜头是创作决定，代码不该替人做。
  for (const scene of script.scenes) {
    const total = shots
      .filter((s) => s.sceneId === scene.id)
      .reduce((sum, s) => sum + s.durationSec, 0);
    if (Math.abs(total - SEGMENT_SEC) > 1) {
      console.warn(`⚠️ 片段「${scene.title}」共 ${total}s，偏离 ${SEGMENT_SEC}s，需要加空镜或压时长`);
    }
  }

  if (script.scenes.length !== SEGMENTS_PER_EPISODE) {
    console.warn(
      `⚠️ 本集 ${script.scenes.length} 个片段，期望 ${SEGMENTS_PER_EPISODE} 个（${SEGMENTS_PER_EPISODE * SEGMENT_SEC}s）`,
    );
  }

  return shots;
}
