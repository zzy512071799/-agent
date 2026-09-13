import Link from 'next/link';
import { ArrowRight, FilmStrip, FolderOpen } from '@phosphor-icons/react/dist/ssr';
import { listWorks } from '@/core/work';

export const dynamic = 'force-dynamic';

export default function HomePage() {
  const works = listWorks();
  return (
    <main className="min-h-[100dvh] bg-[#101010] px-5 py-10 text-zinc-100 md:px-10">
      <div className="mx-auto max-w-7xl">
        <header className="mb-12 flex items-end justify-between border-b border-zinc-800 pb-6">
          <div>
            <p className="mb-3 font-mono text-xs uppercase tracking-[0.28em] text-amber-400">MANJU / CONTROL ROOM</p>
            <h1 className="text-3xl font-semibold tracking-tight">漫剧生产台</h1>
            <p className="mt-2 text-sm text-zinc-500">作品、分集、镜段与成片统一归档。</p>
          </div>
          <FilmStrip size={32} weight="duotone" className="text-zinc-600" />
        </header>
        {works.length === 0 ? (
          <div className="border-t border-zinc-800 py-16 text-zinc-500">
            <FolderOpen size={28} className="mb-4" /><p>还没有可显示的作品。</p>
          </div>
        ) : (
          <section className="grid grid-cols-1 gap-x-10 gap-y-8 md:grid-cols-2">
            {works.map((work) => (
              <article key={work.id} className="border-t border-zinc-800 pt-5">
                <div className="flex items-start justify-between gap-6">
                  <div>
                    <h2 className="text-xl font-medium">{work.title}</h2>
                    <p className="mt-2 font-mono text-xs text-zinc-500">{work.shots ? `${work.shots} 个镜段` : '分集索引项目'}{work.hasFilm ? ' · 已有成片' : ''}</p>
                  </div>
                  <span className="rounded-full border border-zinc-700 px-2 py-1 font-mono text-[10px] text-zinc-500">{work.id}</span>
                </div>
                {work.episodes.length > 0 ? (
                  <div className="mt-6 flex flex-wrap gap-2">
                    {work.episodes.map((episode) => (
                      <Link
                        key={episode.epId}
                        href={`/works/${encodeURIComponent(work.id)}/${episode.epId}`}
                        className="inline-flex items-center gap-2 rounded-full border border-neutral-700 px-3 py-1.5 text-sm text-amber-400 transition-colors hover:border-amber-400/60 hover:bg-amber-400/10"
                      >
                        {episode.epId} · {episode.title} <ArrowRight size={15} />
                      </Link>
                    ))}
                  </div>
                ) : (
                  <Link href={`/works/${encodeURIComponent(work.id)}/ep01`} className="mt-6 inline-flex items-center gap-2 text-sm text-amber-400 transition-transform hover:translate-x-1">
                    打开分集控制台 <ArrowRight size={16} />
                  </Link>
                )}
              </article>
            ))}
          </section>
        )}
      </div>
    </main>
  );
}
