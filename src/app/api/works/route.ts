import { existsSync, readFileSync } from 'node:fs';
import { NextResponse } from 'next/server';
import { WORKS_ROOT, listWorks } from '@/core/work';

export const dynamic = 'force-dynamic';

export function GET() {
  const works = listWorks().map((item) => {
    let project: Record<string, unknown> = {};
    const projectPath = `${WORKS_ROOT}/${item.id}/project.json`;
    try {
      if (existsSync(projectPath)) project = JSON.parse(readFileSync(projectPath, 'utf8'));
    } catch { /* 单个损坏索引不阻断作品列表 */ }
    const episodes = Array.isArray(project.episodes)
      ? (project.episodes as Array<Record<string, unknown>>).map((ep) => {
          const n = Number(ep.episode);
          const epId = `ep${String(n).padStart(2, '0')}`;
          return { epId, title: typeof ep.title === 'string' ? ep.title : epId };
        })
      : [];
    return { workId: item.id, title: item.title, episodes };
  });
  return NextResponse.json({ works });
}
