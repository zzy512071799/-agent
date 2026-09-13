import { createReadStream, existsSync, statSync } from 'node:fs';
import { resolve, sep } from 'node:path';
import { Readable } from 'node:stream';
import { NextRequest } from 'next/server';
import { WORKS_ROOT } from '@/core/work';

export const dynamic = 'force-dynamic';

export function GET(req: NextRequest) {
  const raw = req.nextUrl.searchParams.get('path');
  if (!raw) return new Response('缺少视频路径', { status: 400 });
  // /api/segments 返回的是绝对路径；首页或旧客户端也可能传 storage/works/... 相对路径。
  // 两种格式都统一解析，并禁止访问作品目录之外的文件。
  const file = raw.startsWith('/') || /^[A-Za-z]:[\\/]/.test(raw)
    ? resolve(raw)
    : raw.replace(/^[/\\]+/, '').startsWith('storage/works/')
      ? resolve(process.cwd(), raw.replace(/^[/\\]+/, ''))
      : resolve(WORKS_ROOT, raw.replace(/^[/\\]+/, ''));
  const allowed = `${resolve(WORKS_ROOT)}${sep}`;
  if (!file.startsWith(allowed) || !existsSync(file)) return new Response('视频不存在', { status: 404 });
  const stat = statSync(file);
  const range = req.headers.get('range');
  if (range) {
    const match = range.match(/^bytes=(\d*)-(\d*)$/);
    if (match) {
      const start = match[1] ? Number(match[1]) : Math.max(0, stat.size - Number(match[2]) - 1);
      const end = match[2] ? Math.min(Number(match[2]), stat.size - 1) : stat.size - 1;
      if (start <= end && start < stat.size) {
        return new Response(Readable.toWeb(createReadStream(file, { start, end })) as ReadableStream, {
          status: 206,
          headers: {
            'Content-Type': 'video/mp4',
            'Content-Length': String(end - start + 1),
            'Content-Range': `bytes ${start}-${end}/${stat.size}`,
            'Accept-Ranges': 'bytes',
            'Cache-Control': 'no-store',
          },
        });
      }
    }
    return new Response('无效的视频范围', { status: 416 });
  }
  return new Response(Readable.toWeb(createReadStream(file)) as ReadableStream, {
    headers: { 'Content-Type': 'video/mp4', 'Content-Length': String(stat.size), 'Accept-Ranges': 'bytes', 'Cache-Control': 'no-store' },
  });
}
