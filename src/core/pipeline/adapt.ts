import { readFileSync } from 'node:fs';
import { z } from 'zod';
import { Script } from '../schema';
import { oneApiLlm } from '../providers/llm';
import { SEGMENT_SEC, SEGMENTS_PER_EPISODE } from './storyboard';

/**
 * 剧本agent（storyforge）的 meta.json → 漫剧 Script。
 *
 * storyforge 产出的是小说素材：设定包 + 分集大纲 + 正文。它刻意不做剧本化和分镜，
 * 那是这一层的活。两边的数据契约差异：
 *
 *   storyforge              漫剧
 *   characters[].appearance 中文长句     →  Character.appearance 英文具体描述
 *   （无声音字段）                       →  Character.voice 中文四要素
 *   episodes[].beats 5 条情节点          →  Scene（一集可能要拆成多个场景）
 *   （无画风）                           →  Script.artStyle 英文可见特征
 *
 * 所以这不是字段映射，是一次改编：要把"小说怎么讲"翻译成"画面怎么拍"。
 * 中间必须过一次 LLM，硬映射出来的东西不能用 —— 中文 appearance 塞进图片
 * prompt 会被模型忽略，beats 直接当 scene 会导致一个场景横跨多个地点。
 */

/** storyforge meta.json 的结构。只声明我们要用的字段，其余忽略。 */
const StoryforgeMeta = z.object({
  title: z.string(),
  logline: z.string().default(''),
  genre: z.string().default(''),
  world: z.string().default(''),
  characters: z.array(
    z.object({
      name: z.string(),
      role: z.string().default(''),
      age: z.string().default(''),
      appearance: z.string().default(''),
      personality: z.string().default(''),
      want: z.string().default(''),
      wound: z.string().default(''),
      arc: z.string().default(''),
    }),
  ),
  episodes: z.array(
    z.object({
      index: z.number(),
      title: z.string(),
      summary: z.string().default(''),
      beats: z.array(z.string()).default([]),
      hook: z.string().default(''),
    }),
  ),
  episode_count: z.number().default(0),
});
export type StoryforgeMeta = z.infer<typeof StoryforgeMeta>;

export function readMeta(path: string): StoryforgeMeta {
  return StoryforgeMeta.parse(JSON.parse(readFileSync(path, 'utf8')));
}

const SYSTEM = `你是漫剧改编导演。把小说素材改编成可拍的漫剧剧本。

这是改编不是翻译，你要做三件小说素材里没有的事：

1. appearance 改写成英文，具体到年龄、发色、发型、瞳色、体型、服装。
   原文的中文描述是给读者看的（"走路由腰发力"这种），要换成图片模型能画的外观特征。
2. voice 用中文写，四项必须齐全：年龄段+性别、音高、音色、语速。可再加说话习惯。
   依据原文的 personality 和 age 推断。例："六十岁出头男性，音高低沉，嗓音干涩略沙哑，语速缓慢"
   voiceEn 是同一份描述的英文版，同样四项齐全 —— 视频模型 H3 的提示词正文要求英文。
   例："a man in his early sixties with a low pitch, a dry slightly hoarse timbre and a slow delivery"
3. artStyle 用英文，只写可见的画面特征（线条、上色方式、色调、光线、材质）。
   禁止使用 cinematic / dramatic / beautiful / emotional / consistent 这类抽象词或目标描述。
4. musicDirection 用中文，写全片统一的配乐基调：乐器、速度、情绪走向。
   必须是一句能贯穿全片的描述，不要写成"第几场用什么"的分场编排表 ——
   它会被原文附加到每一个场景的生成提示里。不要用抽象情绪词。
   例："钢琴独奏为主，慢速，中段加入低音弦乐铺底，结尾只留单音渐弱"
   musicDirectionEn 是英文版，只写乐器、速度、节奏和音量变化，不要写情绪功能。
   例："A solo piano at a slow tempo, joined mid-way by sustained low strings, ending on a single fading note"

场景切分规则：
- **每集必须切成正好 ${SEGMENTS_PER_EPISODE} 个 scene**，每个 scene 对应一个 ${SEGMENT_SEC} 秒的
  成片片段，一集正好 ${(SEGMENTS_PER_EPISODE * SEGMENT_SEC) / 60} 分钟。原文一集的信息量
  通常够铺 ${SEGMENTS_PER_EPISODE} 段；不够就把关键节拍展开（前情空镜、反应镜头、环境铺垫），
  过多就合并次要节拍，不要靠加快节奏硬塞。
- 一个 scene 必须是"同一地点 + 同一时间段"的连续片段。原文一集的 beats 常跨越多个
  地点（城中村→废品站→北巷），必须拆成多个 scene。
- 同一地点的内容长到装不进 ${SEGMENT_SEC} 秒时，可以切成两个连续 scene，location 写一样，
  summary 里说清是前半段还是后半段。
- 每个 scene 的 summary 写清这一段发生了什么，供后续拆分镜用
- location 用英文写，具体到可画的环境细节（陈设、光源、材质）
- scenes 的 index 从 0 开始连续，跨集连续编号
- id 用英文小写短横线`;

export interface AdaptOptions {
  /** 只改编这几集。空数组表示全部。集数多时一次改编容易失控，建议 1-3 集一批。 */
  episodes?: number[];
  /** 竖屏还是横屏。漫剧默认竖屏。 */
  aspectRatio?: '9:16' | '16:9';
}

/**
 * meta.json → Script。
 *
 * 不传 episodes 时改编全部集数。集数多的时候产出的 scenes 会很多，
 * 后续 generateStoryboard 一次拆全片容易超上下文，所以支持分批。
 */
export async function adaptToScript(
  meta: StoryforgeMeta,
  opts: AdaptOptions = {},
): Promise<Script> {
  const picked =
    opts.episodes?.length
      ? meta.episodes.filter((e) => opts.episodes!.includes(e.index))
      : meta.episodes;

  if (picked.length === 0) {
    throw new Error(
      `没有匹配的集数。可用集数：${meta.episodes.map((e) => e.index).join(', ')}`,
    );
  }

  const brief = {
    title: meta.title,
    logline: meta.logline,
    genre: meta.genre,
    world: meta.world,
    characters: meta.characters,
    episodes: picked,
  };

  const TEMPLATE = `{"title":"","synopsis":"","artStyle":"","aspectRatio":"${opts.aspectRatio ?? '9:16'}","musicDirection":"","musicDirectionEn":"","characters":[{"id":"","name":"","role":"protagonist|supporting|extra","appearance":"","voice":"","voiceEn":"","personality":"","refImagePath":null,"voiceId":null}],"scenes":[{"id":"","index":0,"title":"","location":"","timeOfDay":"dawn|day|dusk|night","summary":""}]}`;

  const script = await oneApiLlm.completeJson(
    `小说素材：\n${JSON.stringify(brief, null, 2)}\n\n改编成漫剧剧本，按这个 JSON 结构输出：\n${TEMPLATE}`,
    Script,
    { system: SYSTEM },
  );

  // 角色名必须能对回原文：改编时 LLM 可能漏掉配角，漏了后面分镜引用不到
  const adapted = new Set(script.characters.map((c) => c.name));
  const missing = meta.characters.filter((c) => !adapted.has(c.name));
  if (missing.length > 0) {
    console.warn(`⚠️ 改编后缺少角色：${missing.map((c) => c.name).join('、')}`);
  }

  return script;
}
