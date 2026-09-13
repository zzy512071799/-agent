import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { Script, type Shot } from './schema';

/**
 * 作品目录：一个作品一个文件夹，所有产物都在自己的目录里。
 *
 * storage/works/<作品名>/
 *   project.json   作品级索引：剧情章节 → 分集 → 场景 → 镜段 → 素材
 *   story/         设定、大纲、章节（新项目的唯一归档位置）
 *   episodes/      分集剧本、镜段、prompt、媒体和成片
 *   script.json    兼容旧项目的单集剧本 + 分镜（仍是视觉生产唯一真相）
 *   images/        角色卡 char-*.png、场景图 scene-*.png、分镜图 <shotId>-v<n>.png
 *   videos/        即梦动态片段 <shotId>.mp4
 *   audio/         配音 <shotId>-<行号>.mp3
 *   compose/       ffmpeg 中间产物（clip-*.mp4 / concat.txt / subtitles.srt）
 *   film.mp4       成片
 *   .cache/        参考图缩图缓存
 *
 * 目录名直接用作品标题（含中文）。ffmpeg 那边已经用 cwd + 相对文件名绕开了
 * 中文路径问题，所以这里不做拼音转写，保持人眼可读。
 */

const ROOT = 'storage/works';

/** 文件名里不能出现的字符。中文、空格都保留。 */
const UNSAFE = /[/\\:*?"<>|]/g;

export function workId(title: string): string {
  return title.replace(UNSAFE, '-').trim();
}

export interface Work {
  id: string;
  dir: string;
  projectPath: string;
  storyDir: string;
  episodesDir: string;
  scriptPath: string;
  imagesDir: string;
  videosDir: string;
  audioDir: string;
  composeDir: string;
  filmPath: string;
}

export function work(id: string): Work {
  const dir = join(ROOT, workId(id));
  return {
    id: workId(id),
    dir,
    projectPath: join(dir, 'project.json'),
    storyDir: join(dir, 'story'),
    episodesDir: join(dir, 'episodes'),
    scriptPath: join(dir, 'script.json'),
    imagesDir: join(dir, 'images'),
    videosDir: join(dir, 'videos'),
    audioDir: join(dir, 'audio'),
    composeDir: join(dir, 'compose'),
    filmPath: join(dir, 'film.mp4'),
  };
}

export function ensureWork(id: string): Work {
  const w = work(id);
  mkdirSync(w.dir, { recursive: true });
  return w;
}

/** 列出所有作品，带标题、分集和进度，供首页与 CLI 使用。 */
export function listWorks(): Array<{
  id: string;
  title: string;
  shots: number;
  hasFilm: boolean;
  episodes: Array<{ epId: string; title: string }>;
}> {
  if (!existsSync(ROOT)) return [];
  return readdirSync(ROOT, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => {
      const w = work(e.name);
      let title = e.name;
      let shots = 0;
      let episodes: Array<{ epId: string; title: string }> = [];
      const projectPath = w.projectPath;
      if (existsSync(projectPath)) {
        try {
          const project = JSON.parse(readFileSync(projectPath, 'utf8')) as Record<string, unknown>;
          episodes = Array.isArray(project.episodes)
            ? project.episodes.flatMap((ep) => {
                if (!ep || typeof ep !== 'object') return [];
                const item = ep as Record<string, unknown>;
                const number = Number(item.episode);
                if (!Number.isInteger(number) || number < 1) return [];
                return [{ epId: `ep${String(number).padStart(2, '0')}`, title: typeof item.title === 'string' ? item.title : `第${number}集` }];
              })
            : [];
        } catch {
          // project.json 坏了不影响列目录
        }
      }
      if (existsSync(w.scriptPath)) {
        try {
          const d = JSON.parse(readFileSync(w.scriptPath, 'utf8'));
          title = d.script?.title ?? title;
          shots = d.shots?.length ?? 0;
        } catch {
          // script.json 坏了不影响列目录
        }
      }
      return { id: e.name, title, shots, hasFilm: existsSync(w.filmPath), episodes };
    });
}

/** 读作品的剧本 + 分镜。script 过 schema 校验，分镜信任落盘结果。 */
export function readWork(id: string): { script: Script; shots: Shot[] } {
  const w = work(id);
  if (!existsSync(w.scriptPath)) {
    const known = listWorks()
      .map((x) => `  ${x.id}`)
      .join('\n');
    throw new Error(
      `找不到 ${w.scriptPath}\n已有作品：\n${known || '  （还没有作品，先跑 npm run probe:storyboard）'}`,
    );
  }
  const raw = JSON.parse(readFileSync(w.scriptPath, 'utf8'));
  return { script: Script.parse(raw.script), shots: raw.shots as Shot[] };
}

/** 从 argv 里取 --work，缺省时若只有一个作品就用它，多个则报错要求指定。 */
export function workFromArgv(argv: string[]): string {
  const i = argv.indexOf('--work');
  if (i > -1 && argv[i + 1]) return argv[i + 1];

  const works = listWorks();
  if (works.length === 1) return works[0].id;
  if (works.length === 0) throw new Error('还没有作品，先跑 npm run probe:storyboard');
  throw new Error(
    `有多个作品，用 --work 指定一个：\n${works
      .map((w) => `  --work "${w.id}"  ${w.shots} 镜${w.hasFilm ? '，已成片' : ''}`)
      .join('\n')}`,
  );
}

export const WORKS_ROOT = resolve(ROOT);

/**
 * 找到某一集的目录。长剧按故事单元分组（episodes/u4-ep07-09-七号冷库/ep08），
 * 短篇与旧项目是平铺（episodes/ep01），两种布局都要能读。
 *
 * 优先用 project.json 里 `episodes[].dir` 声明的路径——那是唯一权威；
 * 没声明才去猜：先试平铺，再往 episodes/ 下找一层。
 *
 * **所有读分集文件的地方都必须走这里。** 自己拼 `episodes/<epId>` 会在分组
 * 布局的作品上静默拿不到文件：/api/works 走了这个逻辑、/api/segments 没走，
 * 结果《地下三层》在作品列表里看得见，点进出片控制台却 404。
 */
export function resolveEpisodeDir(workDir: string, epId: string, declaredDir?: string): string {
  if (declaredDir) return join(workDir, declaredDir);

  const episodesRoot = join(workDir, 'episodes');
  const flat = join(episodesRoot, epId);
  if (existsSync(flat)) return flat;

  if (existsSync(episodesRoot)) {
    for (const entry of readdirSync(episodesRoot, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const nested = join(episodesRoot, entry.name, epId);
      if (existsSync(nested)) return nested;
    }
  }
  return flat;
}

/** project.json 里某一集声明的 dir，没声明返回 undefined。 */
export function declaredEpisodeDir(
  projectJson: Record<string, unknown> | null,
  epId: string,
): string | undefined {
  if (!projectJson) return undefined;
  const eps = (projectJson.episodes as Array<Record<string, unknown>>) ?? [];
  const epNum = parseInt(epId.replace(/\D/g, ''), 10);
  const hit = eps.find((e) => e.episode === epNum);
  return typeof hit?.dir === 'string' ? hit.dir : undefined;
}

/**
 * 递归列出 media/images 下所有 png 的文件名（不含目录前缀）。
 *
 * 新项目按用途分了子目录（角色/场景/道具/分镜），老项目是平铺的。只用 basename
 * 做键是因为前端和 script.json 里到处都只写文件名，而 /api/images 已经能靠
 * basename 在各子目录里回查。
 */
export function listImageNames(imagesDir: string): string[] {
  if (!existsSync(imagesDir)) return [];
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, entry.name);
      if (entry.isDirectory()) walk(p);
      else if (entry.name.endsWith('.png')) out.push(entry.name);
    }
  };
  walk(imagesDir);
  return [...new Set(out)];
}
