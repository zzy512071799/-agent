import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { Script, Shot } from '../schema';
import type { Reference } from '../providers/seedance';

/**
 * 把一个场景的分镜编译成 Seedance 2.5 的单次生成 prompt。
 *
 * 和即梦时代的根本区别：那时一镜一次调用，画面由首帧图定死，prompt 只写"怎么动"。
 * 现在是一场一次调用，切镜靠 prompt 里的秒级时间戳表达，声音（台词/音效/配乐）
 * 也在同一个 prompt 里，模型联合生成。
 *
 * 所以这里要做的事是：把 Shot[] 摊平成一条带时间轴的叙述，并把角色参考图
 * 用 @图片N 的标签挂到对应的人身上 —— 模型据此保证同一角色跨镜同一张脸、同一个声音。
 */

/** 景别 → 中文镜头术语。Seedance 是中文母语模型，中文提示词比英文更准。 */
const SHOT_SIZE: Record<string, string> = {
  'extreme-wide': '大远景',
  wide: '全景',
  medium: '中景',
  'close-up': '特写',
  'extreme-close-up': '大特写',
};

/**
 * 运镜 → Seedance 词表。
 *
 * 原来的 CameraMove 只有 5 个值，是被 ffmpeg 的 Ken Burns 能力限制出来的
 * （只能缩放/平移）。Seedance 支持推拉摇移跟，所以这里做的是"解除限制"的映射。
 *
 * zoom 和 push 刻意分开：前者是焦距变化（画面压缩感），后者是机身前移
 * （空间穿越感），观感差别明显，导演意图也不同。
 */
const CAMERA: Record<string, string> = {
  static: '固定镜头',
  'zoom-in': '镜头变焦推近',
  'zoom-out': '镜头变焦拉远',
  'push-in': '镜头向前推进',
  'pull-out': '镜头向后拉出',
  'pan-left': '镜头向左摇',
  'pan-right': '镜头向右摇',
  'truck-left': '镜头向左平移',
  'truck-right': '镜头向右平移',
  'tilt-up': '镜头向上摇',
  'tilt-down': '镜头向下摇',
  arc: '镜头环绕主体',
  tracking: '镜头跟随主体移动',
  handheld: '手持镜头轻微晃动',
};

/** 幅度和速度：默认值省略不写，只表达非默认的情况。 */
const AMPLITUDE: Record<string, string> = {
  small: '小幅度',
  medium: '',
  large: '大幅度',
};

const SPEED: Record<string, string> = {
  slow: '缓慢',
  medium: '',
  normal: '',
  fast: '快速',
};

const EMOTION: Record<string, string> = {
  neutral: '平静',
  happy: '愉快',
  sad: '悲伤',
  angry: '愤怒',
  fear: '恐惧',
  surprise: '惊讶',
  affection: '温柔',
};

/** 秒 → mm:ss.SSS。切镜时间戳用这个格式，模型对秒级时间戳响应准确。 */
function stamp(sec: number): string {
  const m = Math.floor(sec / 60);
  const s = sec - m * 60;
  return `${String(m).padStart(2, '0')}:${s.toFixed(3).padStart(6, '0')}`;
}

/**
 * 补句末句号。
 *
 * action 和 motionPrompt 是分开生成的字段，末尾有没有标点不一定。拼接时如果
 * 缺了句号，"动作幅度轻微自然旁白（S4）说" 会粘成一句，模型可能把"旁白"
 * 当成动作描述的一部分。
 */
function sentence(text: string): string {
  const t = text.trim();
  return /[。！？…」]$/.test(t) ? t : `${t}。`;
}

/**
 * 运镜描述：类型 + 幅度 + 速度三个维度合成一句自然中文。
 *
 * 幅度和速度为默认值时省略 —— 全部写满会让每句话都拖着"中等幅度常速"，
 * 反而稀释了真正需要强调的镜头。
 */
function cameraOf(shot: Shot): string {
  const move = CAMERA[shot.cameraMove] ?? shot.cameraMove;
  if (shot.cameraMove === 'static') return move;
  const amp = AMPLITUDE[shot.cameraAmplitude] ?? '';
  const spd = SPEED[shot.cameraSpeed] ?? '';
  return [spd, amp, move].filter(Boolean).join('');
}

export interface CompiledScene {
  prompt: string;
  references: Reference[];
  /** 该场景所有分镜时长之和，向上取整到整秒。 */
  durationSec: number;
  sceneId: string;
}

/**
 * 编译一个场景。
 *
 * refDir 是作品的 images 目录，按 char-<id>.png / scene-<id>.png 约定查参考图。
 * 查不到就只用文字描述 —— 参考图是加分项不是必需品，缺了不该阻断生成。
 */
export function compileScene(
  script: Script,
  shots: Shot[],
  sceneId: string,
  refDir: string,
): CompiledScene {
  const scene = script.scenes.find((s) => s.id === sceneId);
  if (!scene) throw new Error(`场景不存在: ${sceneId}`);

  const sceneShots = shots
    .filter((s) => s.sceneId === sceneId)
    .sort((a, b) => a.index - b.index);
  if (sceneShots.length === 0) throw new Error(`场景 ${sceneId} 没有分镜`);

  // --- 参考图：只带这个场景真正出场的角色，减少无关素材干扰 ---
  const castIds = [...new Set(sceneShots.flatMap((s) => s.characterIds))];
  const references: Reference[] = [];
  const labelOf = new Map<string, string>();

  for (const id of castIds) {
    const p = join(refDir, `char-${id}.png`);
    if (!existsSync(p)) continue;
    const label = `图片${references.length + 1}`;
    references.push({ path: p, label });
    labelOf.set(id, label);
  }

  const scenePath = join(refDir, `scene-${sceneId}.png`);
  let sceneLabel: string | undefined;
  if (existsSync(scenePath)) {
    sceneLabel = `图片${references.length + 1}`;
    references.push({ path: scenePath, label: sceneLabel });
  }

  const nameOf = (id: string): string =>
    script.characters.find((c) => c.id === id)?.name ?? id;

  // --- 说话人 ID + 声音身份：全片稳定，保证同一角色同一个声音 ---
  const speakerOf = new Map<string, string>();
  script.characters.forEach((c, i) => speakerOf.set(c.id, `S${i + 1}`));
  const narratorId = `S${script.characters.length + 1}`;

  // 声音描述只在角色首次开口时给全，之后只用 ID 引用。全给一遍会让 prompt
  // 每段都拖着一串音色描述，反而稀释重点。
  const voiceIntroduced = new Set<string>();
  const voiceOf = (id: string): string =>
    script.characters.find((c) => c.id === id)?.voice ?? '';

  const lines: string[] = [];

  // --- 开场：画风 + 参考图用途声明 ---
  lines.push(`整体画风：${script.artStyle}`);
  lines.push('');

  if (references.length > 0) {
    const decl = castIds
      .filter((id) => labelOf.has(id))
      .map((id) => `@${labelOf.get(id)} 是${nameOf(id)}的形象参考`)
      .join('；');
    const sceneDecl = sceneLabel ? `；@${sceneLabel} 是场景环境参考` : '';
    lines.push(
      `参考素材用途：${decl}${sceneDecl}。` +
        '严格保持参考图中的人物外貌、发型、瞳色、服装配色和身形，全片不得变化。',
    );
    lines.push('');
  }

  lines.push(`场景：${scene.location}，${timeOfDay(scene.timeOfDay)}。`);
  lines.push('');

  // --- 分镜时间轴 ---
  let cursor = 0;
  for (const [i, shot] of sceneShots.entries()) {
    const parts: string[] = [];
    const head = i === 0 ? `【镜头1】` : `【镜头${i + 1}】在 ${stamp(cursor)} 切换到`;

    const size = SHOT_SIZE[shot.shotSize] ?? shot.shotSize;
    const cast = shot.characterIds
      .map((id) => (labelOf.has(id) ? `${nameOf(id)}（@${labelOf.get(id)}）` : nameOf(id)))
      .join('、');

    parts.push(`${head}${size}，${cameraOf(shot)}。`);
    if (cast) parts.push(`出场：${cast}。`);
    parts.push(sentence(shot.action));
    // motionPrompt 里有具体的动作细节（发丝、水滴、光晕），这些是模型最需要的
    if (shot.motionPrompt) {
      parts.push(sentence(shot.motionPrompt.replace(/，不改变人物外貌和构图/g, '')));
    }
    if (shot.sfx) parts.push(sentence(`同步音效：${shot.sfx}`));

    for (const line of shot.lines) {
      const emo = EMOTION[line.emotion] ?? line.emotion;
      if (line.characterId === null) {
        // 旁白必须显式说明画面里的人不动嘴，否则模型会让在场角色跟着旁白开口
        parts.push(
          `旁白（${narratorId}）以画外音、${emo}的语气说：「${line.text}」` +
            `说这句话时画面中所有人物的嘴唇保持闭合。`,
        );
      } else {
        const sid = speakerOf.get(line.characterId) ?? 'S1';
        const voice = voiceOf(line.characterId);
        // 声音描述只给一次：首次开口时建立身份，后续靠 ID 复用
        const intro =
          voice && !voiceIntroduced.has(line.characterId)
            ? `（${sid}，${voice}）`
            : `（${sid}）`;
        if (voice) voiceIntroduced.add(line.characterId);
        parts.push(
          `${nameOf(line.characterId)}${intro}以${emo}的语气开口说话，口型与台词严格同步：「${line.text}」`,
        );
      }
    }

    lines.push(parts.join(''));
    cursor += shot.durationSec;
  }

  lines.push('');

  // --- 声音：模型联合生成，所以要明确写出来 ---
  lines.push(`环境音：${ambienceOf(sceneShots)}`);
  lines.push(`背景音乐：${musicOf(script.musicDirection)}`);
  lines.push('');
  lines.push('不要在画面中生成任何字幕、文字标题或水印。');

  return {
    prompt: lines.join('\n'),
    references,
    durationSec: Math.ceil(cursor),
    sceneId,
  };
}

function timeOfDay(t: string): string {
  return { dawn: '清晨', day: '白天', dusk: '黄昏', night: '夜晚' }[t] ?? t;
}

/**
 * 配乐描述。
 *
 * 只做一件事：补句号避免出现"。。"。不截断内容 —— 试过按分号切只取第一段，
 * 但分号在这个字段里有两种语义：`剑仙` 是分场编排表（切了对），
 * `怀表` 是单曲的情绪弧线（切了就把起伏毁了）。代码分不出来，
 * 所以约束放在 adapt / script 的 prompt 里：要求写全片统一基调，不要写成分场表。
 */
function musicOf(direction: string): string {
  const base = direction.trim().replace(/[。.]+$/, '') || '与画面情绪匹配的配乐';
  return `${base}。角色听不到、只有观众能听到，音量低于对白，不要盖过台词。`;
}

/**
 * 全场持续的环境底噪。
 *
 * 逐镜的动作音效走 Shot.sfx 显式写在对应镜头上，这里只补"整场都在响"的底噪。
 *
 * 这套关键词匹配是权宜之计，已经踩到两次误判：单字"车"把"旧车票"读成马路，
 * "雨"把"雨后的街道"读成正在下雨。所以词组化 + 排除"雨后/雨停"。
 * 更彻底的解法是给 Scene 加一个 ambience 字段由分镜师填，而不是在这里猜。
 */
function ambienceOf(shots: Shot[]): string {
  const text = shots.map((s) => s.action + s.motionPrompt).join('');
  const hints: string[] = [];
  const raining = /雨水|雨丝|下雨|雨点/.test(text) && !/雨后|雨停|雨歇/.test(text);
  if (raining) hints.push('持续的雨声');
  if (/风声|狂风|夜风/.test(text)) hints.push('低沉的风声');
  if (/虫鸣|蝉鸣/.test(text)) hints.push('虫鸣');
  if (/车流|马路|街道|车辆/.test(text)) hints.push('远处的车流声');
  if (hints.length === 0) hints.push('与场景相符的细微环境底噪');
  return `${hints.join('、')}，全程持续。人物动作产生的细微接触声（衣物摩擦、物件放置）随距离自然变化。`;
}
