import { Script } from '../schema';
import { oneApiLlm } from '../providers/llm';

/**
 * 创意 → 剧本。
 *
 * 两个字段是"一致性锚点"，要求写死在 system 里：
 * - appearance 管形象，会原文拼进每一个分镜的 imagePrompt
 * - voice 管声音，会原文拼进每一段有台词的视频 prompt
 *
 * 写得含糊等于放弃一致性。声音那条是接了音视频联合生成之后才需要的 ——
 * 模型从文字描述推出嗓子，不写就每场抽一个不同的人。
 */
const SYSTEM = `你是漫剧编剧。把用户的创意扩写成结构化剧本。

要求：
- characters 里每个角色的 appearance 必须用英文写，具体到年龄、发色、发型、瞳色、体型、服装
- characters 里每个角色的 voice 必须用中文写，包含四项：年龄段+性别、音高（低沉/中等/清亮）、
  音色（沙哑/温润/明亮/沉稳）、语速（缓慢/平稳/急促）。可再加口音或说话习惯。
  例："六十岁出头男性，音高偏低，嗓音略沙哑，语速缓慢，句尾常带一声轻叹"
- artStyle 用英文，描述统一画风。只写可见的画面特征（线条、上色方式、色调、光线、材质），
  不要用 cinematic / dramatic / beautiful / emotional 这类抽象词，也不要写"保持角色一致"这种目标。
- musicDirection 用中文，写全片统一的配乐基调：乐器、速度、情绪走向。
  必须是一句能贯穿全片的描述，不要写成"第几场用什么"的分场编排表 ——
  它会被原文附加到每一个场景的生成提示里。
  例："钢琴独奏为主，慢速，中段加入弦乐铺底，结尾只留单音渐弱"。不要用抽象情绪词。
- scenes 的 index 从 0 开始连续
- voiceEn / musicDirectionEn 是 voice / musicDirection 的英文版，必须都填 ——
  视频模型 H3 的提示词正文要求英文，只有台词保留中文
- id 用英文小写短横线，如 "lin-shu"`;

const TEMPLATE = `{"title":"","synopsis":"","artStyle":"","aspectRatio":"9:16","musicDirection":"","musicDirectionEn":"","characters":[{"id":"","name":"","role":"protagonist|supporting|extra","appearance":"","voice":"","voiceEn":"","personality":"","refImagePath":null,"voiceId":null}],"scenes":[{"id":"","index":0,"title":"","location":"","timeOfDay":"dawn|day|dusk|night","summary":""}]}`;

export async function generateScript(idea: string): Promise<Script> {
  return oneApiLlm.completeJson(
    `创意：${idea}\n\n按这个 JSON 结构输出：\n${TEMPLATE}`,
    Script,
    { system: SYSTEM },
  );
}
