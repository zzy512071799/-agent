import { z } from 'zod';

/**
 * 全链路的数据契约。
 *
 * 每个阶段的产物都是可编辑的结构化数据，用户可以在任意一步改完再往下走。
 * 枚举字段刻意收窄取值范围 —— LLM 在开放文本上不稳定，收窄后可以直接
 * 用 safeParse 卡掉不合格输出并重试。
 */

/** 景别。控制画面里人物占比，直接影响 imagePrompt 的构图描述。 */
export const ShotSize = z.enum([
  'extreme-wide', // 大远景，交代环境
  'wide', // 全景，人物full body
  'medium', // 中景，腰部以上
  'close-up', // 特写，肩部以上
  'extreme-close-up', // 大特写，眼睛/手部等局部
]);
export type ShotSize = z.infer<typeof ShotSize>;

/**
 * 运镜。
 *
 * 第一版只保留 ffmpeg Ken Burns 能模拟的类型（缩放/平移）。接了音视频联合生成
 * 之后这条限制作废了 —— 模型能做真正的推拉摇移跟，所以补上了原来做不到的类型。
 *
 * 幅度和速度是另外两个维度，写在 cameraAmplitude / cameraSpeed 里。
 */
export const CameraMove = z.enum([
  'static', // 固定
  'zoom-in', // 推近（焦距变化）
  'zoom-out', // 拉远
  'push-in', // 推进（机身前移，比 zoom-in 更有空间感）
  'pull-out', // 后拉
  'pan-left', // 左摇（机位不动，镜头水平转）
  'pan-right', // 右摇
  'truck-left', // 左移（机身平移）
  'truck-right', // 右移
  'tilt-up', // 上摇
  'tilt-down', // 下摇
  'arc', // 环绕
  'tracking', // 跟拍
  'handheld', // 手持轻微晃动
]);
export type CameraMove = z.infer<typeof CameraMove>;

/** 运镜幅度。中等是默认值，写进 prompt 时省略。 */
export const CameraAmplitude = z.enum(['small', 'medium', 'large']);
export type CameraAmplitude = z.infer<typeof CameraAmplitude>;

/** 运镜速度。常速是默认值，写进 prompt 时省略。 */
export const CameraSpeed = z.enum(['slow', 'normal', 'fast']);
export type CameraSpeed = z.infer<typeof CameraSpeed>;

/**
 * 情绪。同时用于图片表情描述和视频 prompt 的语气描述，两边共用一套词表。
 *
 * 用 preprocess 兜住词表外的值：LLM 很容易写出 "tense" / "nervous" / "bitter"
 * 这类近义词，直接 fail 会让整批分镜重试。情绪只是语气提示，猜不中降级成
 * neutral 比整体失败好 —— 结构性字段（shotSize / cameraMove）才该严格卡。
 */
const EMOTION_VALUES = [
  'neutral',
  'happy',
  'sad',
  'angry',
  'fear',
  'surprise',
  'affection',
] as const;

/** 常见近义词归一。覆盖不到的一律落到 neutral。 */
const EMOTION_ALIAS: Record<string, (typeof EMOTION_VALUES)[number]> = {
  tense: 'fear',
  nervous: 'fear',
  anxious: 'fear',
  scared: 'fear',
  worried: 'fear',
  calm: 'neutral',
  serious: 'neutral',
  cold: 'neutral',
  determined: 'neutral',
  bitter: 'sad',
  grief: 'sad',
  sorrow: 'sad',
  lonely: 'sad',
  joy: 'happy',
  excited: 'happy',
  amused: 'happy',
  relief: 'happy',
  rage: 'angry',
  annoyed: 'angry',
  irritated: 'angry',
  shocked: 'surprise',
  astonished: 'surprise',
  curious: 'surprise',
  tender: 'affection',
  warm: 'affection',
  loving: 'affection',
};

export const Emotion = z.preprocess((v) => {
  if (typeof v !== 'string') return 'neutral';
  const k = v.trim().toLowerCase();
  if ((EMOTION_VALUES as readonly string[]).includes(k)) return k;
  return EMOTION_ALIAS[k] ?? 'neutral';
}, z.enum(EMOTION_VALUES));
export type Emotion = z.infer<typeof Emotion>;

export const AspectRatio = z.enum(['9:16', '16:9', '4:3', '1:1']);
export type AspectRatio = z.infer<typeof AspectRatio>;

/**
 * 角色。
 *
 * appearance 是整个链路里最关键的一个字段：它既用来生成角色参考图，
 * 又会拼进每一个分镜图的 prompt。角色形象跨镜头不一致是漫剧生成最大的
 * 质量问题，靠的就是"固定 appearance 文本 + 复用参考图做图生图"两条。
 * 所以这里要求写得足够具体（发色发型、瞳色、服装、体型、显著特征）。
 */
export const Character = z.object({
  id: z.string(),
  name: z.string(),
  role: z.enum(['protagonist', 'supporting', 'extra']),
  appearance: z.string().min(10, 'appearance 需要足够具体才能保证跨镜一致性'),
  /**
   * 声音身份。之于声音一致性，等价于 appearance 之于形象一致性。
   *
   * 音视频联合生成的模型（Seedance / H3）里，说话人的声音是从文字描述推出来的。
   * 不写就每次抽一个不同的嗓子 —— 62 岁老人出来个年轻男声，而且每场都不一样。
   * 要写年龄段、性别、音高、音色、语速，这四项是声音辨识度的骨架。
   *
   * 用 default('') 而不是必填：老作品的 script.json 没有这个字段，
   * 缺失时降级成只报语气，不该让整个作品读不出来。
   */
  voice: z.string().default(''),
  /**
   * voice 的英文版，给 H3 用。
   *
   * H3 要求说话人首次出现时用英文交代身份：类型、年龄、性别、是否在画内、
   * 音高、音色、语速。例："a man in his sixties with a low, dry, slightly hoarse
   * voice and a slow delivery"
   */
  voiceEn: z.string().default(''),
  personality: z.string().default(''),
  /** 参考图。生成分镜图时作为图生图的 reference 传入。 */
  refImagePath: z.string().nullable().default(null),
  /** 人工或视觉模型核验结果；文件存在不等于内容与命名正确。 */
  refImageReview: z
    .object({
      status: z.enum(['unverified', 'valid', 'mismatch']),
      note: z.string().default(''),
    })
    .optional(),
  /** TTS 音色标识。走音视频联合生成后不再需要，保留兼容旧数据。 */
  voiceId: z.string().nullable().default(null),
});
export type Character = z.infer<typeof Character>;

/** 场景。一个场景包含多个分镜，同场景的分镜共享环境描述。 */
export const Scene = z.object({
  id: z.string(),
  index: z.number().int().nonnegative(),
  title: z.string(),
  location: z.string(),
  timeOfDay: z.enum(['dawn', 'day', 'dusk', 'night']),
  summary: z.string(),
  /**
   * 场景参考图。和角色参考图同理：同一个场景在不同镜头之间也会漂
   * （书架布局、灯的位置、墙的颜色每镜都变），观感上和角色漂一样糟。
   * 该场景下所有分镜出图时都会带上它。
   */
  refImagePath: z.string().nullable().default(null),
});
export type Scene = z.infer<typeof Scene>;

/** 一句台词。characterId 为 null 表示旁白。 */
export const Line = z.object({
  characterId: z.string().nullable(),
  text: z.string(),
  emotion: Emotion.default('neutral'),
});
export type Line = z.infer<typeof Line>;

/**
 * 分镜。链路的核心单元 —— 图片、音频、合成都以 shot 为粒度。
 *
 * durationSec 初值由 LLM 估，阶段 3 生成配音后会用真实音频时长回写，
 * 保证画面和声音对齐。
 */
export const Shot = z.object({
  id: z.string(),
  sceneId: z.string(),
  index: z.number().int().nonnegative(),
  durationSec: z.number().positive().max(30),
  shotSize: ShotSize,
  cameraMove: CameraMove.default('static'),
  cameraAmplitude: CameraAmplitude.default('medium'),
  cameraSpeed: CameraSpeed.default('normal'),
  /** 出场角色。用于拼 prompt 时带上对应的 appearance 和参考图。 */
  characterIds: z.array(z.string()).default([]),
  /** 画面里发生的动作，中文描述，给人看的。 */
  action: z.string(),
  /** 同一个动作的英文描述，拼进 imagePrompt。中英分开存是因为界面要中文、模型要英文。 */
  actionEn: z.string(),
  lines: z.array(Line).default([]),
  /**
   * 该镜头的音效。
   *
   * 走音视频联合生成后声音由模型出，所以音效必须显式写出来，否则模型只给
   * 环境底噪。这里只放"这一镜特有的动作音"（开门、脚步、玻璃碎），
   * 全场持续的环境音走场景级描述，不在这里重复。
   */
  sfx: z.string().default(''),
  /**
   * sfx 的英文版。
   *
   * H3 的扩写规范要求正文写英文，只有台词和画面内可见文字保留原语言。
   * 中英各存一份而不是只留英文：Seedance 是中文母语模型，中文提示词更准，
   * 两条路都得留着。缺失时 h3.ts 会退化用中文，能跑但不合规范。
   */
  sfxEn: z.string().default(''),
  /** 交给图片模型的 prompt，英文，由 action + 角色 appearance + 场景 + 景别拼成。 */
  imagePrompt: z.string(),
  negativePrompt: z.string().default(''),
  /**
   * 交给视频模型的 prompt，中文，只描述"画面怎么动"（表情变化、发丝飘动、镜头推移）。
   *
   * 和 imagePrompt 是两种东西，必须分开：图生视频时画面内容已经被首帧图定死了，
   * 再描述一遍内容会让模型重新构图，把辛苦锚定的一致性破坏掉。
   */
  motionPrompt: z.string().default(''),
  /** motionPrompt 的英文版，给 H3 用。理由同 sfxEn。 */
  motionPromptEn: z.string().default(''),
  /** Wan3 视频模式；老作品缺失时由出片接口按默认模式处理。 */
  wan3Mode: z.enum(['t2v', 'first_frame', 'reference', 'I2VA', 'L2VA', 'FL2VA', 'T2VA']).optional(),
  /** Wan3 视频提示词。已有人工定稿时必须原样保留。 */
  wan3Prompt: z.string().optional(),
  /** 镜头结束状态，供自动 Prompt 编译器明确收束动作链。 */
  wan3EndState: z.string().optional(),
  /** Wan3 首帧/尾帧及参考图路径，保留相对路径和历史绝对路径兼容性。 */
  firstFramePath: z.string().nullable().optional(),
  lastFramePath: z.string().nullable().optional(),
  wan3ReferencePaths: z.array(z.string()).optional(),
  wan3ReferenceAudioUrls: z.array(z.string()).optional(),
  wan3FirstFrameFrom: z.string().optional(),
  requiresVoiceRef: z.boolean().optional(),
  hasVoiceRef: z.boolean().optional(),
  inheritFrom: z.string().nullable().optional(),
  propPaths: z.array(z.string()).optional(),
  compositionPaths: z.array(z.string()).optional(),
});
export type Shot = z.infer<typeof Shot>;

/** 剧本。阶段 1 的最终产物。 */
export const Script = z.object({
  title: z.string(),
  synopsis: z.string(),
  /** 全局画风，拼进每个 imagePrompt，保证整片统一。 */
  artStyle: z.string(),
  aspectRatio: AspectRatio.default('9:16'),
  /**
   * 全片配乐方向。
   *
   * 音视频联合生成时，配乐由模型出。不给方向的话每场抽一个不同的曲风，
   * 整片听起来像拼盘。要写乐器、速度、情绪走向，不要写"大气""感人"这种抽象词。
   */
  musicDirection: z.string().default(''),
  /** musicDirection 的英文版，给 H3 的 non_diegetic_music 段用。 */
  musicDirectionEn: z.string().default(''),
  characters: z.array(Character),
  scenes: z.array(Scene),
});
export type Script = z.infer<typeof Script>;

/**
 * LLM 拆分镜时的输出格式。
 *
 * 和 Shot 的区别：不含 id / imagePrompt —— id 由服务端生成，imagePrompt 由
 * 服务端用模板拼（LLM 直接写 prompt 会忽略角色 appearance，导致形象漂移）。
 */
export const ShotDraft = Shot.omit({
  id: true,
  sceneId: true,
  imagePrompt: true,
  negativePrompt: true,
});
export type ShotDraft = z.infer<typeof ShotDraft>;

/** LLM 拆分镜的完整返回，按场景分组。 */
export const StoryboardDraft = z.object({
  shots: z.array(
    ShotDraft.extend({
      /** 引用 Script.scenes 里的 index，服务端据此映射成 sceneId。 */
      sceneIndex: z.number().int().nonnegative(),
    }),
  ),
});
export type StoryboardDraft = z.infer<typeof StoryboardDraft>;
