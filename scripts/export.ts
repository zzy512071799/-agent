/**
 * 导出上传包：把作品目录整理成人工上传网站时顺手的形式。
 *
 * 为什么需要这一步：作品目录是给代码用的（script.json 36KB、图片按 id 命名），
 * 人工上传时要的是"按顺序排好的图 + 能直接粘贴的 prompt + 一张能边传边标记的表"。
 *
 * 用法：npm run export [--work 作品名]
 */
import { copyFile, mkdir, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { loadEnv } from '../src/core/env';

// 导出不调任何接口，但 work.ts 之外的模块可能读 env，保持一致
try {
  loadEnv();
} catch {
  // 没有 .env 也能导出
}

import { Shot } from '../src/core/schema';
import { readWork, work, workFromArgv } from '../src/core/work';
import { compileScene } from '../src/core/pipeline/seedance';
import { compileSegmentH3 } from '../src/core/pipeline/h3';
import { SEGMENT_SEC, SEGMENTS_PER_EPISODE } from '../src/core/pipeline/storyboard';

const SHOT_SIZE_CN: Record<string, string> = {
  'extreme-wide': '大远景',
  wide: '全景',
  medium: '中景',
  'close-up': '特写',
  'extreme-close-up': '大特写',
};

const CAMERA_CN: Record<string, string> = {
  static: '固定',
  'zoom-in': '变焦推',
  'zoom-out': '变焦拉',
  'push-in': '推进',
  'pull-out': '后拉',
  'pan-left': '左摇',
  'pan-right': '右摇',
  'truck-left': '左移',
  'truck-right': '右移',
  'tilt-up': '上摇',
  'tilt-down': '下摇',
  arc: '环绕',
  tracking: '跟拍',
  handheld: '手持',
};

const EMOTION_CN: Record<string, string> = {
  neutral: '平静',
  happy: '愉快',
  sad: '悲伤',
  angry: '愤怒',
  fear: '恐惧',
  surprise: '惊讶',
  affection: '温柔',
};

/** 文件名安全化。中文保留，只清掉路径非法字符。 */
function safe(name: string): string {
  return name.replace(/[/\\:*?"<>|]/g, '-').trim();
}

async function main() {
  const id = workFromArgv(process.argv);
  const w = work(id);
  const { script, shots: rawShots } = readWork(id);
  const shots = rawShots.map((s) => Shot.parse(s));

  const out = join(w.dir, 'export');
  const dirs = {
    root: out,
    chars: join(out, '角色'),
    scenes: join(out, '场景'),
    frames: join(out, '分镜图'),
    prompts: join(out, '片段prompt'),
  };
  for (const d of Object.values(dirs)) await mkdir(d, { recursive: true });

  // --- 参考图：按中文名重命名，人工上传时不用猜 id ---
  // exportedName 同时用于场景 prompt 的头部，保证表里写的名字和目录里的一致
  const exportedName = new Map<string, string>();
  for (const c of script.characters) {
    const src = join(w.imagesDir, `char-${c.id}.png`);
    if (!existsSync(src)) continue;
    const name = `${safe(c.name)}.png`;
    await copyFile(src, join(dirs.chars, name));
    exportedName.set(`char-${c.id}.png`, `角色/${name}`);
  }
  for (const s of script.scenes) {
    const src = join(w.imagesDir, `scene-${s.id}.png`);
    if (!existsSync(src)) continue;
    const name = `${safe(s.title)}.png`;
    await copyFile(src, join(dirs.scenes, name));
    exportedName.set(`scene-${s.id}.png`, `场景/${name}`);
  }

  // --- 分镜图：按全片顺序编号，方便批量按序上传 ---
  const ordered = [...shots].sort((a, b) => {
    const sa = script.scenes.findIndex((s) => s.id === a.sceneId);
    const sb = script.scenes.findIndex((s) => s.id === b.sceneId);
    return sa === sb ? a.index - b.index : sa - sb;
  });

  const frameName = new Map<string, string>();
  for (const [i, shot] of ordered.entries()) {
    // 取版本号最大的那张：重 roll 时旧版本不删，最新的才是人工挑过的
    const versions = [3, 2, 1].map((v) => join(w.imagesDir, `${shot.id}-v${v}.png`));
    const src = versions.find((p) => existsSync(p));
    if (!src) continue;
    const name = `${String(i + 1).padStart(2, '0')}-${shot.id}.png`;
    await copyFile(src, join(dirs.frames, name));
    frameName.set(shot.id, name);
  }

  // --- 片段 prompt：一段一个文件，可直接粘进网站的多模态参考生视频 ---
  // 文件名带序号：一集 8 段按顺序生成、按顺序拼片，序号是上传时唯一的顺序依据
  //
  // target 决定编译成哪家的格式。两家的提示词规范完全不同（H3 是六段英文结构，
  // Seedance 是中文自然语言），不是换个措辞能兼容的，所以分成两个编译器。
  const target = process.argv.includes('--target')
    ? process.argv[process.argv.indexOf('--target') + 1]
    : 'h3';
  if (target !== 'h3' && target !== 'seedance') {
    throw new Error(`--target 只能是 h3 或 seedance，收到 ${target}`);
  }

  let segNo = 0;
  for (const scene of script.scenes) {
    if (!shots.some((s) => s.sceneId === scene.id)) continue;
    segNo += 1;
    const compiled =
      target === 'h3'
        ? compileSegmentH3(script, shots, scene.id, w.imagesDir)
        : compileScene(script, shots, scene.id, w.imagesDir);
    // 头部写导出后的中文文件名，不写内部 id —— 人工上传时对着目录能直接找到
    const refList = compiled.references
      .map((r) => {
        const raw = r.path.split('/').pop() ?? '';
        return `#   ${r.label} = ${exportedName.get(raw) ?? `分镜图/${frameName.get(raw.replace(/-v\d+\.png$/, '')) ?? raw}`}`;
      })
      .join('\n');
    const header =
      `# 第 ${segNo} 段 ${scene.title}（${compiled.durationSec}s，${target.toUpperCase()}，参考图 ${compiled.references.length} 张）\n` +
      `# 按顺序上传这些参考图，prompt 里的标签与之对应：\n` +
      `${refList}\n\n`;
    const name = `${String(segNo).padStart(2, '0')}-${safe(scene.title)}.txt`;
    await writeFile(join(dirs.prompts, name), header + compiled.prompt);
  }

  await writeFile(join(out, '分镜表.md'), buildSheet(script, ordered, frameName));

  console.log(`《${script.title}》导出完成 → ${out}`);
  console.log(`  分镜表.md      ${ordered.length} 镜`);
  console.log(`  角色/          ${script.characters.length} 张`);
  console.log(`  场景/          ${script.scenes.length} 张`);
  console.log(`  分镜图/        ${frameName.size} 张${frameName.size < ordered.length ? `（缺 ${ordered.length - frameName.size} 张）` : ''}`);
  console.log(`  片段prompt/    ${segNo} 段，共 ${Math.ceil(shots.reduce((a, b) => a + b.durationSec, 0))}s`);
}

/**
 * 分镜表。
 *
 * 刻意不用 markdown 表格：视频 prompt 有几百字，表格里会挤成一坨没法读。
 * 用小节 + 字段列表，屏幕上和打印出来都能扫。
 *
 * 每镜留一行「结果」空着，上传完手写通过/重抽/改了什么 —— 这份记录后面
 * 就是 prompt 模板调优的依据，等接 API 批量跑时不用从零试。
 */
function buildSheet(
  script: ReturnType<typeof readWork>['script'],
  shots: Shot[],
  frameName: Map<string, string>,
): string {
  const nameOf = (id: string): string =>
    script.characters.find((c) => c.id === id)?.name ?? id;

  const lines: string[] = [
    `# ${script.title} 分镜表`,
    '',
    script.synopsis,
    '',
    `全片 ${shots.length} 镜 / ${script.scenes.length} 段，约 ${Math.ceil(shots.reduce((a, b) => a + b.durationSec, 0))} 秒，${script.aspectRatio}`,
    '',
    `交付单位是"段"：一段 ${SEGMENT_SEC}s，一集 ${SEGMENTS_PER_EPISODE} 段。每段对应 \`片段prompt/\` 里的一个文件，`,
    '按序号逐段生成，最后按序号拼成整集。',
    '',
    '## 画风（每次生成都要带上）',
    '',
    '```',
    script.artStyle,
    '```',
    '',
    '## 配乐方向',
    '',
    '```',
    script.musicDirection || '（剧本未指定，生成时需要自己补）',
    '```',
    '',
    '## 角色',
    '',
    '声音描述是跨场景音色一致性的锚点，每次生成都要原文带上：',
    '',
    ...script.characters.flatMap((c) => [
      `- **${c.name}**（${c.role}）`,
      `  - 形象：${c.appearance}`,
      `  - 声音：${c.voice || '⚠️ 未填，生成时音色会每场漂移'}`,
    ]),
    '',
  ];

  let currentScene = '';
  let segNo = 0;
  for (const [i, shot] of shots.entries()) {
    const scene = script.scenes.find((s) => s.id === shot.sceneId);
    if (scene && scene.id !== currentScene) {
      currentScene = scene.id;
      segNo += 1;
      // 片段时长要标出来：一段一次生成，偏离 15s 就拼不出整集片长
      const total = shots
        .filter((s) => s.sceneId === scene.id)
        .reduce((sum, s) => sum + s.durationSec, 0);
      const off = Math.abs(total - SEGMENT_SEC) > 1 ? `　⚠️ 偏离 ${SEGMENT_SEC}s` : '';
      lines.push(
        '',
        `## 第 ${segNo} 段　${scene.title}　${Math.ceil(total)}s${off}`,
        '',
        `${scene.location}｜${{ dawn: '清晨', day: '白天', dusk: '黄昏', night: '夜晚' }[scene.timeOfDay]}`,
        '',
        scene.summary,
        '',
      );
    }

    const no = String(i + 1).padStart(2, '0');
    const cast = shot.characterIds.map(nameOf).join('、') || '无人物';
    const amp = { small: '小幅', medium: '', large: '大幅' }[shot.cameraAmplitude] ?? '';
    const spd = { slow: '慢速', normal: '', fast: '快速' }[shot.cameraSpeed] ?? '';
    const camera = [spd, amp, CAMERA_CN[shot.cameraMove] ?? shot.cameraMove]
      .filter(Boolean)
      .join('');

    lines.push(
      `### ${no}　${SHOT_SIZE_CN[shot.shotSize] ?? shot.shotSize}　${camera}　${shot.durationSec}s`,
      '',
      `- 图：\`${frameName.get(shot.id) ?? '⚠️ 缺图'}\`　出场：${cast}`,
      `- 画面：${shot.action}`,
    );

    for (const line of shot.lines) {
      const who = line.characterId === null ? '旁白' : nameOf(line.characterId);
      lines.push(`- 台词（${who}／${EMOTION_CN[line.emotion] ?? line.emotion}）：${line.text}`);
    }

    if (shot.sfx) lines.push(`- 音效：${shot.sfx}`);

    lines.push(
      '- 画面运动：',
      '',
      '  ```',
      `  ${shot.motionPrompt || '（无）'}`,
      '  ```',
      '',
      '- 结果：',
      '',
    );
  }

  return lines.join('\n');
}

main().catch((e) => {
  console.error(`失败: ${e.message}`);
  process.exit(1);
});
