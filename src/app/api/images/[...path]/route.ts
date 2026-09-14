/**
 * 图片代理：把 storage/works/<work>/episodes/<ep>/media/images/ 下的图安全代理给浏览器。
 * GET /api/images/<workId>/<epId>/<用途子目录>/<filename>  — 新版路径，支持按用途分类的子目录
 * GET /api/images/<workId>/<epId>/<filename>              — 平铺，兼容旧项目
 * GET /api/images/<filename>                              — 旧版兼容，自动路由到 下山只想躺平/ep01
 *
 * 单集目录兼容两种布局：平铺 episodes/epNN/ 与按故事单元分组 episodes/uN-<单元名>/epNN/。
 * media/images/ 下兼容平铺与按用途分子目录（角色/场景/道具/分镜）两种布局。
 */
import { existsSync, createReadStream, statSync, readdirSync } from 'node:fs';
import { resolve, join, basename } from 'node:path';
import { NextRequest } from 'next/server';

const ALLOWED_PREFIX = resolve(process.cwd(), 'storage/works');

/** 先试平铺，再在 episodes/ 下往里找一层单元目录。 */
function resolveImagesDir(workId: string, epId: string): string {
  const episodesRoot = resolve(process.cwd(), 'storage/works', workId, 'episodes');
  const flat = join(episodesRoot, epId, 'media/images');
  if (existsSync(flat)) return flat;

  if (existsSync(episodesRoot)) {
    for (const entry of readdirSync(episodesRoot)) {
      const nested = join(episodesRoot, entry, epId, 'media/images');
      if (existsSync(nested)) return nested;
    }
  }
  return flat;
}

/**
 * 在 images 目录下定位文件：先按传入的相对路径找（支持用途子目录），
 * 找不到再退回平铺的文件名，最后递归扫描用途子目录。
 * 这样 script.json 里写子目录路径或只写文件名都能取到图。
 */
function resolveImageFile(imagesDir: string, rel: string): string {
  const direct = join(imagesDir, rel);
  if (existsSync(direct)) return direct;

  const name = basename(rel);
  const flat = join(imagesDir, name);
  if (existsSync(flat)) return flat;

  const walk = (dir: string): string | null => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const nested = join(dir, entry.name);
      if (entry.isFile() && entry.name === name) return nested;
      if (entry.isDirectory()) {
        const hit = walk(nested);
        if (hit) return hit;
      }
    }
    return null;
  };
  if (existsSync(imagesDir)) {
    const hit = walk(imagesDir);
    if (hit) return hit;
  }
  return direct;
}

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ path: string[] }> },
) {
  const { path } = await params;

  let imageRel: string;
  let imagesDir: string;

  if (path.length >= 3) {
    // /api/images/<workId>/<epId>/[<用途>/]<filename>
    const [workId, epId, ...fileParts] = path;
    imageRel = fileParts.join('/');
    imagesDir = resolveImagesDir(workId, epId);
  } else if (path.length === 1) {
    // legacy: /api/images/<filename>
    imageRel = basename(path[0]);
    imagesDir = resolve(process.cwd(), 'storage/works/下山只想躺平/episodes/ep01/media/images');
  } else {
    return new Response('路径格式错误', { status: 400 });
  }

  if (!imageRel || imageRel.includes('..')) return new Response('禁止', { status: 403 });

  let abs = resolve(resolveImageFile(imagesDir, imageRel));
  // 连续镜头的真实尾帧由 ffmpeg 保存在 media/videos，仍通过同一图片预览入口展示。
  if (!existsSync(abs) && basename(imageRel).endsWith('_last_actual.png')) {
    const videosDir = resolve(imagesDir, '..', 'videos');
    const videoFrame = join(videosDir, basename(imageRel));
    if (existsSync(videoFrame)) abs = videoFrame;
  }
  // 双重越界防护：既要在 storage/works 内，也不能跳出本集的 images/videos 目录
  if (!abs.startsWith(ALLOWED_PREFIX)) return new Response('禁止', { status: 403 });
  const allowedDir = abs.includes('/media/videos/') ? resolve(imagesDir, '..', 'videos') : resolve(imagesDir);
  if (!abs.startsWith(allowedDir)) return new Response('禁止', { status: 403 });
  if (!existsSync(abs)) return new Response('图片不存在', { status: 404 });

  const stat = statSync(abs);
  const ext = abs.split('.').pop()?.toLowerCase() ?? 'png';
  const mime = ext === 'jpg' || ext === 'jpeg' ? 'image/jpeg' : 'image/png';

  // 资产会被同名覆盖重出（如四宫图按场景锚点重制），强缓存会让浏览器 24h 内看不到新图。
  // 改用 mtime+size ETag 协商缓存：文件没变走 304，变了立刻拿到新字节。
  const etag = `"${stat.size}-${stat.mtimeMs}"`;
  if (req.headers.get('if-none-match') === etag) {
    return new Response(null, { status: 304, headers: { ETag: etag } });
  }

  const nodeStream = createReadStream(abs);
  const webStream = new ReadableStream({
    start(c) {
      nodeStream.on('data', (chunk) => c.enqueue(chunk));
      nodeStream.on('end', () => c.close());
      nodeStream.on('error', (e) => c.error(e));
    },
  });

  return new Response(webStream, {
    headers: {
      'Content-Type': mime,
      'Content-Length': String(stat.size),
      'Cache-Control': 'no-cache',
      ETag: etag,
    },
  });
}
