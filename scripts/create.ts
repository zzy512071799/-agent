/**
 * 从剧本agent 的产物一路做到可上传的素材包。
 *
 * 这是三个 agent 的串联点：
 *   剧本agent (storyforge)  →  export/meta.json
 *        ↓ adaptToScript      改编：小说素材 → 漫剧剧本（换英文外观、补声音、拆场景）
 *   漫剧agent               →  script.json → 参考图 → 分镜图
 *        ↓ npm run export     整理成人工上传包
 *
 * 每一步都跳过已有产物，所以中途挂掉可以直接重跑接着做，不重烧额度。
 *
 * 用法：
 *   npm run create -- --meta <meta.json路径> [--work 作品名] [--episodes 1,2] [--concurrency 10] [--mock]
 *   npm run create -- --idea "一句话创意" [--work 作品名]
 */
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { z } from 'zod';
import { loadEnv } from '../src/core/env';
loadEnv();

import { oneApiLlm } from '../src/core/providers/llm';
import { Script, Shot } from '../src/core/schema';
import { ensureWork, work } from '../src/core/work';
import { readMeta, adaptToScript } from '../src/core/pipeline/adapt';
import { generateScript } from '../src/core/pipeline/script';
import { generateStoryboard, buildImagePrompt, buildWan3Prompt } from '../src/core/pipeline/storyboard';
import {
  generateCharacterRefs,
  generateSceneRefs,
  generateShotImages,
} from '../src/core/pipeline/images';
import { createOneApiImageProvider, createMockImageProvider } from '../src/core/providers/image';

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 ? process.argv[i + 1] : undefined;
}
const has = (name: string): boolean => process.argv.includes(`--${name}`);

function elapsed(t0: bigint): string {
  return `${(Number(process.hrtime.bigint() - t0) / 1e9).toFixed(0)}s`;
}

async function main() {
  const metaPath = arg('meta');
  const idea = arg('idea');
  if (!metaPath && !idea) {
    throw new Error(
      '需要 --meta <meta.json路径> 或 --idea "创意"\n' +
        '例：npm run create -- --meta ../剧本agent/workspace/projects/剑仙今天修空调/export/meta.json --episodes 1',
    );
  }

  const episodes = arg('episodes')
    ?.split(',')
    .map((s) => Number(s.trim()))
    .filter((n) => Number.isFinite(n));

  // 作品名要在改编之前定出来，才能先查有没有已有产物。
  // 否则每次重跑都白烧一次改编（LLM 调用，~50s），而且改编结果是不确定的：
  // 实测同一集两次改编给出 6 场和 5 场，打印出来的场景数会和实际复用的分镜对不上。
  let workId = arg('work') ?? '';
  if (!workId && metaPath) {
    if (!existsSync(metaPath)) throw new Error(`找不到 ${metaPath}`);
    const title = readMeta(metaPath).title;
    workId = episodes?.length ? `${title}-第${episodes.join('_')}集` : title;
  }

  const existingPath = workId ? work(workId).scriptPath : null;
  const reuse = existingPath !== null && existsSync(existingPath);

  // --- 1. 剧本：复用已有 / 改编已有小说 / 从创意原创 ---
  let script: Script;
  let shots: Shot[];

  if (reuse) {
    const raw = JSON.parse(readFileSync(existingPath!, 'utf8'));
    script = Script.parse(raw.script);
    shots = (raw.shots as unknown[]).map((s) => Shot.parse(s));

    const style = arg('style');
    if (style) script = { ...script, artStyle: style };

    // --fill-en：给已有作品补 H3 需要的英文字段（motionPromptEn / sfxEn /
    // voiceEn / musicDirectionEn）。这些字段是后加的，老作品里全是空的，
    // 而重拆分镜会换掉镜头数量、让已生成的分镜图作废，代价太大 ——
    // 所以单独做一次翻译回填，只动文本不动结构。
    if (has('fill-en')) {
      const t = process.hrtime.bigint();
      const filled = await fillEnglish(script, shots);
      script = filled.script;
      shots = filled.shots;
      console.log(`补英文字段: ${filled.count} 处 (${elapsed(t)})`);
      writeFileSync(work(workId).scriptPath, JSON.stringify({ script, shots }, null, 2));
    }

    // --restoryboard：剧本留着，只重拆分镜。分镜是最容易需要重来的一步
    // （段时长不齐、某段生成失败），而改编要 ~50s 且结果不确定，不该跟着重跑。
    if (has('restoryboard')) {
      const t = process.hrtime.bigint();
      shots = await generateStoryboard(script);
      console.log(`重拆分镜: ${shots.length} 个镜头 (${elapsed(t)})`);
      writeFileSync(work(workId).scriptPath, JSON.stringify({ script, shots }, null, 2));
    }

    // imagePrompt 是分镜阶段拼好落盘的，画风被冻在字符串里。改了 script.artStyle
    // 只重跑出图是不生效的 —— 实测把画风换成真人后，参考图（文生图，现拼 prompt）
    // 出来是真人，分镜图（图生图，读落盘的 imagePrompt）还是二次元。
    // 所以复用时按当前 artStyle 重拼一遍，代价是零，省掉一整类"改了没反应"的困惑。
    const sceneById = new Map(script.scenes.map((s) => [s.id, s]));
    shots = shots.map((shot) => {
      const scene = sceneById.get(shot.sceneId);
      if (!scene) return shot;
      return {
        ...shot,
        imagePrompt: buildImagePrompt(shot, script, scene, script.characters),
        wan3Prompt: shot.wan3Prompt?.trim() || buildWan3Prompt(shot, script.characters),
      };
    });

    console.log(
      `复用已有产物：《${script.title}》${script.characters.length} 角色 / ` +
        `${script.scenes.length} 场景 / ${shots.length} 镜头（imagePrompt 按当前画风重拼）`,
    );
  } else {
    const t0 = process.hrtime.bigint();
    if (metaPath) {
      const meta = readMeta(metaPath);
      console.log(`《${meta.title}》${meta.episodes.length} 集，${meta.characters.length} 角色`);
      console.log(`改编${episodes?.length ? ` 第 ${episodes.join('、')} 集` : '全部'}...`);
      script = await adaptToScript(meta, { episodes });
    } else {
      console.log(`创意：${idea}`);
      script = await generateScript(idea!);
    }
    workId ||= script.title;
    console.log(
      `剧本: ${script.title} — ${script.characters.length} 角色 / ${script.scenes.length} 场景 (${elapsed(t0)})`,
    );

    // 画风覆盖必须在拆分镜之前：imagePrompt 是分镜阶段拼好落盘的，之后再改 artStyle
    // 对已落盘的 prompt 不生效。改编提示词里没有画风偏好，真人/二次元靠这个开关切。
    const style = arg('style');
    if (style) {
      script = { ...script, artStyle: style };
      console.log(`画风覆盖为：${style.slice(0, 60)}...`);
    }

    const t1 = process.hrtime.bigint();
    shots = await generateStoryboard(script);
    console.log(`分镜: ${shots.length} 个镜头 (${elapsed(t1)})`);
    writeFileSync(ensureWork(workId).scriptPath, JSON.stringify({ script, shots }, null, 2));
  }

  const w = ensureWork(workId);
  const total = shots.reduce((sum, s) => sum + s.durationSec, 0);
  console.log(`预估片长 ${Math.ceil(total)}s\n`);

  // --- 3. 参考图 + 分镜图 ---
  const image = has('mock')
    ? createMockImageProvider({ workDir: w.dir })
    : createOneApiImageProvider({ workDir: w.dir });

  // 参考图必须先出完再出分镜图，顺序不能颠倒 —— 分镜图靠参考图做图生图。
  // 参考图数量少（角色+场景通常 10 个以内），并发开满没意义，用一半。
  const concurrency = Number(arg('concurrency') ?? 4);
  const t2 = process.hrtime.bigint();
  const characters = await generateCharacterRefs(
    script,
    image,
    Math.max(2, Math.ceil(concurrency / 2)),
    w.imagesDir,
  );
  const scenes = await generateSceneRefs(
    script,
    image,
    Math.max(2, Math.ceil(concurrency / 2)),
    w.imagesDir,
  );
  const refOk = [...characters, ...scenes].filter((x) => x.refImagePath).length;
  console.log(
    `参考图: ${refOk}/${characters.length + scenes.length} 张 (${elapsed(t2)})` +
      (refOk < characters.length + scenes.length ? ' ⚠️ 有缺失，缺的会退化成纯文生图' : ''),
  );

  const t3 = process.hrtime.bigint();
  const images = await generateShotImages(shots, script, characters, scenes, image, {
    concurrency,
    imagesDir: w.imagesDir,
  });
  console.log(
    `分镜图: ${images.length}/${shots.length} 张 (${elapsed(t3)})` +
      (images.length < shots.length ? ' ⚠️ 重跑本命令会补齐缺的' : ''),
  );

  // 参考图路径回写进 script.json：导出和后续重跑都要靠它找图
  writeFileSync(
    w.scriptPath,
    JSON.stringify({ script: { ...script, characters, scenes }, shots }, null, 2),
  );

  console.log(`\n完成 → ${w.dir}`);
  console.log(`下一步：npm run export -- --work "${workId}"`);
}

/**
 * 补齐 H3 需要的英文字段。
 *
 * 只翻译，不改写：中文那一份仍然是 Seedance 路径的输入，两边必须说同一件事，
 * 否则同一段素材换个平台生成出来的内容会不一样。
 */
async function fillEnglish(
  script: Script,
  shots: Shot[],
): Promise<{ script: Script; shots: Shot[]; count: number }> {
  const todo = shots.filter(
    (s) => (s.motionPrompt && !s.motionPromptEn) || (s.sfx && !s.sfxEn),
  );
  const chars = script.characters.filter((c) => c.voice && !c.voiceEn);
  const needMusic = Boolean(script.musicDirection) && !script.musicDirectionEn;
  if (todo.length === 0 && chars.length === 0 && !needMusic) {
    return { script, shots, count: 0 };
  }

  const Out = z.object({
    shots: z
      .array(z.object({ id: z.string(), motionPromptEn: z.string(), sfxEn: z.string() }))
      .default([]),
    characters: z.array(z.object({ id: z.string(), voiceEn: z.string() })).default([]),
    musicDirectionEn: z.string().default(''),
  });

  const brief = {
    shots: todo.map((s) => ({ id: s.id, motionPrompt: s.motionPrompt, sfx: s.sfx })),
    characters: chars.map((c) => ({ id: c.id, voice: c.voice })),
    musicDirection: needMusic ? script.musicDirection : '',
  };

  const res = await oneApiLlm.completeJson(
    `把下面这些中文字段翻译成英文，用于 MiniMax H3 视频提示词：\n${JSON.stringify(brief, null, 2)}\n\n` +
      '按这个结构输出：{"shots":[{"id":"","motionPromptEn":"","sfxEn":""}],' +
      '"characters":[{"id":"","voiceEn":""}],"musicDirectionEn":""}',
    Out,
    {
      system:
        '你是视频提示词翻译。只翻译，不增删内容，不做润色改写。\n' +
        '- motionPromptEn 只写画面怎么动，不写画面内容和人物外貌\n' +
        '- 英文里不要出现角色名（连拼音也不要），用 the woman / the older man 之类指代 ——\n' +
        '  H3 的提示词里角色靠 <Subject N> 标签绑定，出现名字会被当成一个没定义过的新实体\n' +
        '- sfxEn 只写这一镜的动作音，源字段为空就输出空字符串\n' +
        '- voiceEn 保留四要素：年龄段+性别、音高、音色、语速\n' +
        '- musicDirectionEn 只写乐器、速度、节奏、音量变化，不写情绪功能\n' +
        '- 禁止使用 cinematic / dramatic / beautiful / emotional 这类抽象词',
    },
  );

  const byShot = new Map(res.shots.map((s) => [s.id, s]));
  const byChar = new Map(res.characters.map((c) => [c.id, c]));
  let count = 0;

  const nextShots = shots.map((s) => {
    const hit = byShot.get(s.id);
    if (!hit) return s;
    count += 1;
    return {
      ...s,
      motionPromptEn: s.motionPromptEn || hit.motionPromptEn,
      sfxEn: s.sfxEn || hit.sfxEn,
    };
  });

  const nextChars = script.characters.map((c) => {
    const hit = byChar.get(c.id);
    if (!hit) return c;
    count += 1;
    return { ...c, voiceEn: c.voiceEn || hit.voiceEn };
  });

  const musicDirectionEn = script.musicDirectionEn || res.musicDirectionEn;
  if (needMusic && musicDirectionEn) count += 1;

  return {
    script: { ...script, characters: nextChars, musicDirectionEn },
    shots: nextShots,
    count,
  };
}

main().catch((e) => {
  console.error(`失败: ${e.message}`);
  process.exit(1);
});