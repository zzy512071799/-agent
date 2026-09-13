import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { Script, Shot } from '../schema';

/**
 * 把一个 15 秒片段编译成 MiniMax H3 的「全能参考」（Ref2VA）prompt。
 *
 * 为什么用全能参考而不是 I2VA：我们手上有角色四视图卡，这是整条流水线的
 * 一致性锚点。I2VA 只吃一张首帧图，角色卡就浪费了；全能参考能把每个角色
 * 声明成一个 <Subject N>，跨镜引用同一个标签，H3 才知道"这几个镜头里是同一个人"。
 * 段首分镜图仍然作为 <Picture 1> 当 [Shot 1] 的首帧，两种关系可以叠加，
 * 所以 summary 的任务类型是 [keyframe completion + reference generation]。
 *
 * 和 Seedance 编译器的根本差异：
 * - Seedance 吃中文自然语言；H3 的扩写规范要求正文写英文，只有台词和画面内
 *   可见文字保留原语言（放在 <d>[Chinese] ...</d> 里）
 * - H3 有固定的六段结构和固定的关系标记（fully_preserved / weak_reference 等），
 *   不是自由散文
 * - H3 单次上限 15 秒，正好等于我们的片段长度，所以一段 = 一次生成
 */

/** 景别 → H3 英文构图术语。 */
const SHOT_SIZE: Record<string, string> = {
  'extreme-wide': 'an extreme wide shot',
  wide: 'a wide full-body shot',
  medium: 'a medium shot',
  'close-up': 'a close-up',
  'extreme-close-up': 'an extreme close-up',
};

/**
 * 运镜 → H3 官方词表。
 *
 * 必须逐字用官方写法（Push In / Truck Left / Arc Shot ...），自己造词
 * H3 就退化成"随便动一下"。zoom 和 push 分开：前者变焦，后者机身位移。
 */
const CAMERA: Record<string, string> = {
  static: 'holds a static shot',
  'zoom-in': 'zooms in',
  'zoom-out': 'zooms out',
  'push-in': 'pushes in',
  'pull-out': 'pulls out',
  'pan-left': 'pans left',
  'pan-right': 'pans right',
  'truck-left': 'trucks left',
  'truck-right': 'trucks right',
  'tilt-up': 'tilts up',
  'tilt-down': 'tilts down',
  arc: 'moves in an arc shot around the subject',
  tracking: 'follows the subject in a tracking shot',
  handheld: 'shakes slightly in a handheld manner',
};

/** 幅度 / 速度：默认值省略。全写满会让每句都拖着 medium/normal，稀释真正的强调。 */
const AMPLITUDE: Record<string, string> = {
  small: 'with small amplitude',
  medium: '',
  large: 'with large amplitude',
};

const SPEED: Record<string, string> = {
  slow: 'at slow speed',
  medium: '',
  normal: '',
  fast: 'at fast speed',
};

/** 情绪 → 英文语气短语。H3 的 delivery 描述写在 <d> 外面。 */
const EMOTION: Record<string, string> = {
  neutral: 'in a level tone',
  happy: 'in a bright tone',
  sad: 'in a subdued tone',
  angry: 'in a sharp raised tone',
  fear: 'in a tight, unsteady tone',
  surprise: 'in a startled tone',
  affection: 'in a soft, warm tone',
};

const TIME_OF_DAY: Record<string, string> = {
  dawn: 'pale dawn light',
  day: 'flat daylight',
  dusk: 'low golden dusk light',
  night: 'night lighting from artificial sources',
};

/** 秒 → MM:SS.mmm。H3 要求切镜时间戳严格递增且落在时长内。 */
function stamp(sec: number): string {
  const m = Math.floor(sec / 60);
  const s = sec - m * 60;
  return `${String(m).padStart(2, '0')}:${s.toFixed(3).padStart(6, '0')}`;
}

/** 补句末句号，避免相邻字段拼成一句。 */
function sentence(text: string): string {
  const t = text.trim().replace(/[。]$/, '.');
  if (!t) return '';
  return /[.!?]$/.test(t) ? t : `${t}.`;
}

function cameraOf(shot: Shot): string {
  const move = CAMERA[shot.cameraMove] ?? CAMERA.static;
  if (shot.cameraMove === 'static') return `the camera ${move}`;
  const amp = AMPLITUDE[shot.cameraAmplitude] ?? '';
  const spd = SPEED[shot.cameraSpeed] ?? '';
  return ['the camera', move, amp, spd].filter(Boolean).join(' ');
}

export interface CompiledH3Segment {
  /** 可直接粘进 H3 的完整 prompt（六段）。 */
  prompt: string;
  /** 按上传顺序排列的参考图，label 就是 prompt 里的 <Picture N>。 */
  references: Array<{ path: string; label: string }>;
  durationSec: number;
  sceneId: string;
  mode: 'I2VA' | 'FL2VA' | 'Ref2VA' | 'T2VA';
}

/**
 * 编译一个片段。
 *
 * refDir 是作品的 images 目录，按 char-<id>.png / scene-<id>.png / <shotId>-v1.png
 * 的约定查图。查不到就退化成纯文字描述 —— 参考图是加分项，缺了不该阻断生成。
 *
 * 上传顺序即 <Picture N> 的编号顺序，这里定成：段首分镜图 → 角色卡 → 场景图。
 * 首帧图放第一个，因为它是唯一有"具体帧"语义的图，编号错位代价最大。
 */
export function compileSegmentH3(
  script: Script,
  shots: Shot[],
  sceneId: string,
  refDir: string,
  frameOptions?: { firstFramePath?: string | null; lastFramePath?: string | null },
): CompiledH3Segment {
  const scene = script.scenes.find((s) => s.id === sceneId);
  if (!scene) throw new Error(`片段不存在: ${sceneId}`);

  const segShots = shots.filter((s) => s.sceneId === sceneId).sort((a, b) => a.index - b.index);
  if (segShots.length === 0) throw new Error(`片段 ${sceneId} 没有分镜`);

  const total = segShots.reduce((sum, s) => sum + s.durationSec, 0);

  const references: CompiledH3Segment['references'] = [];
  const pic = (path: string): string => {
    references.push({ path, label: `Picture ${references.length + 1}` });
    return `<Picture ${references.length}>`;
  };

  // --- Picture 1：段首分镜图，作为 [Shot 1] 的首帧 ---
  const firstFrame = frameOptions?.firstFramePath
    ?? [3, 2, 1].map((v) => join(refDir, `${segShots[0].id}-v${v}.png`)).find((p) => existsSync(p));
  const firstFrameLabel = firstFrame ? pic(firstFrame) : null;

  // --- Subject：先角色后场景。只带本段真正出场的角色，无关素材会干扰 H3 ---
  const castIds = [...new Set(segShots.flatMap((s) => s.characterIds))];
  const subjectOf = new Map<string, string>();
  const definitions: string[] = [];
  const retention: string[] = [];

  const shotsWith = (id: string): string =>
    segShots
      .map((s, i) => (s.characterIds.includes(id) ? `[Shot ${i + 1}]` : null))
      .filter(Boolean)
      .join(', ');

  for (const id of castIds) {
    const c = script.characters.find((x) => x.id === id);
    if (!c) continue;
    const label = `<Subject ${subjectOf.size + 1}>`;
    subjectOf.set(id, label);

    const p = join(refDir, `char-${id}.png`);
    const src = existsSync(p) ? ` shown in ${pic(p)}` : '';
    definitions.push(`${label} is the character${src}: ${c.appearance}`);
    retention.push(
      `${label} (appears in ${shotsWith(id) || '[Shot 1]'}): fully_preserved - ` +
        'face, hairstyle, outfit and body build stay identical in every shot.',
    );
  }

  const scenePath = join(refDir, `scene-${sceneId}.png`);
  let envLabel: string | null = null;
  if (existsSync(scenePath)) {
    envLabel = `<Subject ${subjectOf.size + 1}>`;
    definitions.push(
      `${envLabel} is the environment shown in ${pic(scenePath)}: ${scene.location}.`,
    );
    retention.push(
      `${envLabel} (appears in all shots): fully_preserved - ` +
        'layout, materials and light sources of the location are retained.',
    );
  }

  if (firstFrameLabel) {
    retention.push(
      `${firstFrameLabel} ([Shot 1] first frame): fully_preserved - ` +
        'the opening composition, subject placement and lighting come from this frame.',
    );
  }

  // --- 说话人 ID：全片稳定，同一角色永远同一个 (Sx)，否则声音每段漂 ---
  const speakerOf = new Map<string, string>();
  script.characters.forEach((c, i) => speakerOf.set(c.id, `S${i + 1}`));
  const narrator = `S${script.characters.length + 1}`;

  // 音色描述只在首次开口时给全，之后靠 ID 复用
  const voiceDone = new Set<string>();

  // --- detailed_description ---
  const body: string[] = [
    `The target video is ${styleOf(script.artStyle)}, lit by ${TIME_OF_DAY[scene.timeOfDay] ?? 'natural light'}.`,
  ];

  let cursor = 0;
  for (const [i, shot] of segShots.entries()) {
    const parts: string[] = [];
    parts.push(
      i === 0 ? '[Shot 1]' : `[Shot ${i + 1}] At ${stamp(cursor)}, the shot cuts to`,
    );

    const size = SHOT_SIZE[shot.shotSize] ?? 'a medium shot';
    const cast = shot.characterIds
      .map((id) => subjectOf.get(id))
      .filter(Boolean)
      .join(' and ');

    if (i === 0) {
      parts.push(
        firstFrameLabel
          ? `${cap(size)} opens from ${firstFrameLabel}${envLabel ? `, inside ${envLabel}` : ''}.`
          : `${cap(size)} opens${envLabel ? ` inside ${envLabel}` : ''}.`,
      );
    } else {
      parts.push(`${size}${envLabel ? ` inside ${envLabel}` : ''}.`);
    }

    if (cast) parts.push(`${cast} ${shot.characterIds.length > 1 ? 'are' : 'is'} in frame.`);
    parts.push(cap(sentence(delabel(shot.actionEn, subjectOf))));
    parts.push(`${cap(cameraOf(shot))}.`);

    const motion = shot.motionPromptEn || shot.motionPrompt;
    if (motion) parts.push(cap(sentence(delabel(motion, subjectOf))));

    const sfx = shot.sfxEn || shot.sfx;
    if (sfx) parts.push(sentence(`Synchronized with the action: ${sfx}`));

    for (const line of shot.lines) {
      const tone = EMOTION[line.emotion] ?? EMOTION.neutral;
      if (line.characterId === null) {
        // 旁白：H3 规范要求用固定短语 says in an off-screen voiceover，
        // 且紧跟一句"嘴唇闭合"，否则画面里的人会跟着旁白开口
        parts.push(
          `A narrator (${narrator}) says in an off-screen voiceover ${tone}: ` +
            `<d>[Chinese] ${line.text}</d> while the lips of everyone on screen remain completely closed.`,
        );
      } else {
        const sid = speakerOf.get(line.characterId) ?? 'S1';
        const subject = subjectOf.get(line.characterId) ?? 'The character';
        const c = script.characters.find((x) => x.id === line.characterId);
        const voice = c?.voiceEn || c?.voice || '';
        const intro = voice && !voiceDone.has(line.characterId) ? `, ${voice},` : '';
        if (voice) voiceDone.add(line.characterId);
        parts.push(
          `${subject} (${sid})${intro} says ${tone}, lips synchronized to the words: ` +
            `<d>[Chinese] ${line.text}</d>`,
        );
      }
    }

    body.push(parts.join(' '));
    cursor += shot.durationSec;
  }

  // --- 组装六段。顺序是规范固定的，不能改 ---
  const out: string[] = [];
  out.push('subject_definitions:');
  out.push(definitions.join('\n') || 'N/A');
  out.push('');
  out.push('summary:');
  out.push(
    `[${firstFrameLabel ? 'keyframe completion + reference generation' : 'reference generation'}] ` +
      `A ${total.toFixed(0)}-second segment titled "${scene.title}". ` +
      (firstFrameLabel ? `${firstFrameLabel} is the first frame of [Shot 1]. ` : '') +
      `${[...subjectOf.values(), envLabel].filter(Boolean).join(', ')} are carried through ` +
      `${segShots.length} shot${segShots.length > 1 ? 's' : ''} without changing identity or location.`,
  );
  out.push('');
  out.push('retention_analysis:');
  out.push(retention.join('\n') || 'N/A');
  out.push('');
  out.push('detailed_description:');
  out.push(body.join('\n'));
  out.push('');
  out.push('overall_soundscape:');
  out.push(ambienceOf(segShots));
  out.push('');
  out.push('non_diegetic_music:');
  out.push(musicOf(script.musicDirectionEn || script.musicDirection));

  return {
    prompt: out.join('\n'),
    references,
    durationSec: Math.ceil(total),
    sceneId,
    mode: frameOptions?.lastFramePath ? 'FL2VA' : firstFrameLabel ? 'I2VA' : 'Ref2VA',
  };
}

/**
 * 画风句。
 *
 * artStyle 是给图片模型写的长串（镜头、镀膜、材质一路堆到底），整段塞进 H3 的
 * 开场句会把风格锚点淹掉。这里只取前两个逗号分句 —— 画风的定性信息都在开头，
 * 后面是画面材质细节，那些已经由参考图承载了。
 *
 * 还要去掉 "film still" / "photo" 这类静帧词：那是给图片模型的说法，
 * 写进视频提示词里等于让 H3 生成一张不动的画。
 */
function styleOf(artStyle: string): string {
  const head = artStyle
    .split(',')[0]
    .replace(/\b(film still|still frame|photograph|photo)\b/gi, '')
    .replace(/\bof real human actors\b/gi, '')
    .replace(/\s{2,}/g, ' ')
    .trim();
  return `in a ${head.replace(/^[A-Z]/, (m) => m.toLowerCase()) || 'live-action cinematic'} style`;
}

/** 句首大写。各字段是分开生成的，拼成一句话时首字母往往还是小写。 */
function cap(text: string): string {
  return text.replace(/^[a-z]/, (m) => m.toUpperCase());
}

/**
 * 把英文里出现的角色名换成 <Subject N>。
 *
 * 翻译出来的 motionPromptEn 经常带上角色名（"Su Yan's gaze becomes sharp"），
 * H3 会把它当成一个没定义过的新实体，和已经声明的 <Subject N> 对不上。
 * 角色 id 就是拼音短横线形式（su-yan），反推出 "Su Yan" 做替换。
 */
function delabel(text: string, subjectOf: Map<string, string>): string {
  let out = text;
  for (const [id, label] of subjectOf) {
    const name = id
      .split('-')
      .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
      .join(' ');
    out = out.replace(new RegExp(`\\b${name}\\b`, 'g'), label);
  }
  return out;
}

/**
 * 全片持续的环境底噪。
 *
 * 逐镜动作音走 Shot.sfx 挂在对应镜头上，这里只补"整段都在响"的底噪。
 * 关键词匹配是权宜之计（踩过"旧车票"被读成马路、"雨后"被读成正在下雨），
 * 所以用词组并排除"雨后/雨停"。彻底的解法是给 Scene 加 ambience 字段。
 */
function ambienceOf(shots: Shot[]): string {
  const text = shots.map((s) => s.action + s.motionPrompt).join('');
  const hints: string[] = [];
  if (/雨水|雨丝|下雨|雨点/.test(text) && !/雨后|雨停|雨歇/.test(text)) {
    hints.push('steady rain');
  }
  if (/风声|狂风|夜风/.test(text)) hints.push('low wind');
  if (/虫鸣|蝉鸣/.test(text)) hints.push('insect calls');
  if (/车流|马路|街道|车辆/.test(text)) hints.push('distant traffic');
  const base = hints.length > 0 ? hints.join(' and ') : 'faint room tone matching the location';
  return (
    `${base.charAt(0).toUpperCase()}${base.slice(1)} continues underneath the whole segment. ` +
    'Fabric movement, footsteps and small contact sounds from the characters stay at natural distance.'
  );
}

/** 配乐。只补一句"角色听不到"的界定，内容不截断 —— 见 seedance.ts 里同名函数的说明。 */
function musicOf(direction: string): string {
  const base = direction.trim().replace(/[。.]+$/, '');
  if (!base) return 'N/A';
  return `${base}. Audible only to the audience, mixed below the dialogue.`;
}
