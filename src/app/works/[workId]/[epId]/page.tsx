'use client';

import { Fragment, useState, useEffect, useCallback, useRef, type ReactNode } from 'react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import {
  FilmStrip,
  ArrowLeft,
  Play,
  ArrowClockwise,
  CheckCircle,
  XCircle,
  Clock,
  VideoCamera,
  WarningCircle,
  CaretDown,
  CaretRight,
  Lightning,
  Folder,
  CloudArrowUp,
  Image as ImageIcon,
  FileText,
  Link as LinkIcon,
  Warning,
  Microphone,
  MagnifyingGlass,
} from '@phosphor-icons/react';

// ─── 类型 ──────────────────────────────────────────────────────────────────
type SegStatus = 'idle' | 'running' | 'done' | 'failed' | 'skipped';
type H3Status = 'Queueing' | 'Processing' | 'Success' | 'Fail';
type DepRole =
  | 'first_frame'
  | 'last_frame'
  | 'reference_image'
  | 'visual_reference'
  | 'prop'
  | 'composition'
  | 'source';

interface DepItem {
  index: number;
  token: string;
  name: string;
  path?: string;
  role: DepRole;
  label: string;
  exists: boolean;
  previewUrl?: string;
  uploadable?: boolean;
  issue?: string;
}

interface AssetSummary {
  status: 'ready' | 'incomplete';
  staticImages: number;
  requiredFrames: { present: number; total: number };
  missingFrames: string[];
  issues: Array<{ name: string; issue?: string }>;
}

/** 一段的静态配置（来自 /api/segments）+ 本次运行的动态状态，合成一个对象。 */
interface Seg {
  id: string;
  chainName: string;
  mode: string;
  durationSec: number;
  prompt: string;
  note: string;
  inheritFrom: string | null;
  requiresVoiceRef: boolean;
  hasVoiceRef: boolean;
  deps: DepItem[];
  hasVideo: boolean;
  prevSegId: string | null;
  prevHasActualLastFrame: boolean;
  // ↓ 运行时
  status: SegStatus;
  elapsed?: number;
  videoPath?: string;
  errorMsg?: string;
  taskId?: string;
  h3Status?: H3Status;
}

interface Chain {
  name: string;
  segs: Seg[];
  expanded: boolean;
}

interface WorkSummary {
  workId: string;
  episodes: Array<{ epId: string; title: string }>;
}

/**
 * /api/segments 返回的形状。**段号在接口里叫 `segId`，在本地状态里叫 `id`**，
 * 载入时必须显式改名——直接 `{...s}` 展开会让每一段的 `id` 都是 undefined，
 * 后果不是报错而是静默错乱：key 缺失、点任何一段都命中数组里的第一段。
 */
type SegConfig = Omit<Seg, 'id' | 'status' | 'videoPath'> & { segId: string; videoPath: string | null };

// ─── 展示用映射表 ─────────────────────────────────────────────────────────
/** wan3 用 wan3Mode 的原值（first_frame…），旧项目是 H3 的四字母命名，两套都要认。 */
const MODE_META: Record<string, { label: string; cls: string }> = {
  first_frame: { label: '首帧', cls: 'bg-amber-400/10 text-amber-400' },
  first_last_frame: { label: '首尾帧', cls: 'bg-purple-400/10 text-purple-400' },
  reference: { label: '全能参考', cls: 'bg-sky-400/10 text-sky-400' },
  t2v: { label: '文生视频', cls: 'bg-blue-400/10 text-blue-400' },
  I2VA: { label: 'I2VA', cls: 'bg-amber-400/10 text-amber-400' },
  FL2VA: { label: 'FL2VA', cls: 'bg-purple-400/10 text-purple-400' },
  L2VA: { label: 'L2VA', cls: 'bg-rose-400/10 text-rose-400' },
  T2VA: { label: 'T2VA', cls: 'bg-blue-400/10 text-blue-400' },
};
const modeMeta = (m: string) => MODE_META[m] ?? { label: m, cls: 'bg-neutral-800 text-neutral-400' };

async function readApiJson<T>(res: Response): Promise<T> {
  const body = await res.text();
  if (!res.ok) {
    throw new Error(`API ${res.status}${body.trim() ? `: ${body.slice(0, 200)}` : ': 响应为空'}`);
  }
  if (!body.trim()) throw new Error(`API ${res.status}: 响应为空`);
  try {
    return JSON.parse(body) as T;
  } catch {
    throw new Error(`API ${res.status}: JSON 格式无效（${body.slice(0, 120)}）`);
  }
}

const DEP_META: Record<DepRole, { label: string; cls: string }> = {
  first_frame: { label: '首帧', cls: 'text-amber-400 bg-amber-400/10 border-amber-400/20' },
  last_frame: { label: '尾帧', cls: 'text-purple-400 bg-purple-400/10 border-purple-400/20' },
  reference_image: { label: '参考', cls: 'text-sky-400 bg-sky-400/10 border-sky-400/20' },
  visual_reference: { label: '视觉参考', cls: 'text-cyan-400 bg-cyan-400/10 border-cyan-400/20' },
  prop: { label: '道具', cls: 'text-neutral-400 bg-neutral-800 border-neutral-700' },
  composition: { label: '构图', cls: 'text-neutral-400 bg-neutral-800 border-neutral-700' },
  source: { label: '首帧源图', cls: 'text-violet-400 bg-violet-400/10 border-violet-400/20' },
};

/** 北京区标准版每秒单价（元）。-prime 高速版是 1.5 倍。H3 不在此表，不估价。 */
const WAN3_PRICE: Record<string, number> = { '480P': 0.3, '720P': 0.6, '1080P': 1.2 };

/** 只有首帧/尾帧是「缺了就跑不了」的，参考图与道具卡缺失不阻塞。 */
const isRequiredFrame = (d: DepItem) => d.role === 'first_frame' || d.role === 'last_frame';

/** 等待确认的一次生成。scope 用于文案，chain 为空表示全集。 */
interface PendingRun {
  title: string;
  chain?: string;
  segment?: string;
  segs: Seg[];
}

/**
 * 从视频的真实像素反推档位。480P 出来是 474×842、720P 约 720×1280、1080P 约 1080×1920，
 * 所以拿短边判断即可。这里刻意不读配置里的 resolution——那是「这次要跑什么」，
 * 而标识要回答的是「这个文件到底是什么」，重跑换档之后两者会不一致。
 */
function resolutionTier(w: number, h: number): string {
  const shortSide = Math.min(w, h);
  if (shortSide <= 560) return '480P';
  if (shortSide <= 840) return '720P';
  return '1080P';
}

function SegIcon({ status, h3Status, size = 16 }: { status: SegStatus; h3Status?: H3Status; size?: number }) {
  if (status === 'done') return <CheckCircle size={size} weight="fill" className="text-emerald-400" />;
  if (status === 'failed') return <XCircle size={size} weight="fill" className="text-red-400" />;
  if (status === 'skipped') return <CheckCircle size={size} weight="fill" className="text-neutral-500" />;
  if (status === 'running') {
    if (h3Status === 'Queueing') return <CloudArrowUp size={size} className="text-sky-400 animate-pulse" />;
    return <ArrowClockwise size={size} className="text-amber-400 animate-spin" />;
  }
  return <Clock size={size} className="text-neutral-600" />;
}

function statusText(s: SegStatus, h3Status?: H3Status) {
  if (s === 'running') {
    if (h3Status === 'Queueing') return '排队中';
    if (h3Status === 'Processing') return '处理中';
    return '提交中';
  }
  const map: Record<SegStatus, string> = { idle: '待生成', running: '生成中', done: '完成', failed: '失败', skipped: '已跳过' };
  return map[s];
}

// ─── 主页：提示词 · 图片 · 生成三合一 ─────────────────────────────────────
export default function ProducePage() {
  const params = useParams<{ workId: string; epId: string }>();
  const workId = decodeURIComponent(params.workId);
  const epId = params.epId;

  const [chains, setChains] = useState<Chain[]>([]);
  const [resolution, setResolution] = useState<string>('480P');
  const [provider, setProvider] = useState<'h3' | 'wan3'>('wan3');
  const [log, setLog] = useState<string[]>([]);
  const [running, setRunning] = useState(false);
  const [activeChain, setActiveChain] = useState<string | null>(null);
  const [epTitle, setEpTitle] = useState('');
  const [episodes, setEpisodes] = useState<Array<{ epId: string; title: string }>>([]);
  const [epDir, setEpDir] = useState('');
  const [assetCatalog, setAssetCatalog] = useState<DepItem[]>([]);
  const [assetSummary, setAssetSummary] = useState<AssetSummary | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [loadErr, setLoadErr] = useState('');
  // 待确认的生成动作。生成要花钱，所以点按钮只是提请求，真正开跑要过这一关。
  const [pending, setPending] = useState<PendingRun | null>(null);

  // taskId → polling interval handle
  const pollHandles = useRef<Map<string, ReturnType<typeof setInterval>>>(new Map());

  // 从 /api/segments 初始化链和段（提示词、图片依赖、时长一次全带回来）
  useEffect(() => {
    const controller = new AbortController();
    let active = true;

    // 切换分集时先移除上一集的内容，避免新请求完成前继续显示旧镜头。
    setChains([]);
    setSelected(null);
    setAssetCatalog([]);
    setAssetSummary(null);
    setEpDir('');
    setLoadErr('');

    fetch(`/api/segments?work=${encodeURIComponent(workId)}&episode=${epId}`, {
      signal: controller.signal,
    })
      .then((r) => readApiJson<{
        error?: string;
        epDir?: string;
        segments?: SegConfig[];
        assetCatalog?: DepItem[];
        assetSummary?: AssetSummary;
      }>(r))
      .then((d) => {
        if (!active) return;
        if (d.error) { setLoadErr(d.error); return; }
        setEpDir(d.epDir ?? '');
        setAssetCatalog(d.assetCatalog ?? []);
        setAssetSummary(d.assetSummary ?? null);
        const segsData = (d.segments ?? []) as SegConfig[];
        const chainMap = new Map<string, Seg[]>();
        for (const s of segsData) {
          if (!chainMap.has(s.chainName)) chainMap.set(s.chainName, []);
          chainMap.get(s.chainName)!.push({
            ...s,
            id: s.segId,
            // 已出片的段带着绝对路径回来，直接进 videoPath，刷新后详情栏就能继续放。
            videoPath: s.videoPath ?? undefined,
            status: s.hasVideo ? 'skipped' : 'idle',
          });
        }
        setChains([...chainMap.entries()].map(([name, segs]) => ({ name, segs, expanded: true })));
        setSelected(segsData[0]?.segId ?? null);
      })
      .catch((error: unknown) => {
        if (!active || (error instanceof DOMException && error.name === 'AbortError')) return;
        setLoadErr(String(error));
      });

    fetch('/api/works', { signal: controller.signal })
      .then((r) => readApiJson<{ works?: WorkSummary[] }>(r))
      .then((d) => {
        if (!active) return;
        const work = (d.works ?? []).find((w: { workId: string }) => w.workId === workId);
        const workEpisodes = work?.episodes ?? [];
        setEpisodes(workEpisodes);
        const ep = workEpisodes.find((e: { epId: string }) => e.epId === epId);
        setEpTitle(ep?.title ?? '');
      })
      .catch((error: unknown) => {
        if (!active || (error instanceof DOMException && error.name === 'AbortError')) return;
      });

    return () => {
      active = false;
      controller.abort();
      // 组件卸载时清理所有轮询
      for (const h of pollHandles.current.values()) clearInterval(h);
    };
  }, [workId, epId]);

  const allSegs = chains.flatMap((c) => c.segs);
  const totalSegs = allSegs.length;
  const doneSegs = allSegs.filter((s) => s.status === 'done' || s.status === 'skipped').length;
  const failedSegs = allSegs.filter((s) => s.status === 'failed').length;
  const totalSec = allSegs.reduce((n, s) => n + s.durationSec, 0);
  const pendingSec = allSegs
    .filter((s) => s.status !== 'done' && s.status !== 'skipped')
    .reduce((n, s) => n + s.durationSec, 0);
  const unitPrice = provider === 'wan3' ? WAN3_PRICE[resolution] : undefined;
  const seg = allSegs.find((s) => s.id === selected) ?? null;

  const appendLog = useCallback((msg: string) => {
    setLog((prev) => [...prev.slice(-199), `${new Date().toLocaleTimeString()}  ${msg}`]);
  }, []);

  const updateSeg = useCallback(
    (chainName: string, segId: string, patch: Partial<Seg>) => {
      setChains((prev) =>
        prev.map((c) =>
          c.name !== chainName
            ? c
            : { ...c, segs: c.segs.map((s) => (s.id === segId ? { ...s, ...patch } : s)) },
        ),
      );
    },
    [],
  );

  // 启动对某个 taskId 的 10s 轮询
  const startPoll = useCallback(
    (taskId: string, chainName: string, segId: string, taskProvider: 'h3' | 'wan3') => {
      if (pollHandles.current.has(taskId)) return;

      const handle = setInterval(async () => {
        try {
          const params = new URLSearchParams({ taskId, provider: taskProvider });
          const res = await fetch(`/api/task-status?${params.toString()}`);
          if (!res.ok) return;
          const data = await readApiJson<{ status: H3Status; message?: string; taskId: string }>(res);

          updateSeg(chainName, segId, { h3Status: data.status });

          if (data.status === 'Success') {
            clearInterval(handle);
            pollHandles.current.delete(taskId);
            appendLog(`任务完成 ${segId} (task=${taskId})`);
            // SSE seg:done 会处理最终状态，这里只更新 h3Status
          } else if (data.status === 'Fail') {
            clearInterval(handle);
            pollHandles.current.delete(taskId);
            appendLog(`任务失败 ${segId} (task=${taskId}): ${data.message ?? '未知错误'}`);
          } else {
            appendLog(`轮询 ${segId} → ${data.status} (task=${taskId})`);
          }
        } catch {
          // 网络抖动不停轮询，等下次
        }
      }, 10_000);

      pollHandles.current.set(taskId, handle);
    },
    [updateSeg, appendLog],
  );

  const stopPoll = useCallback((taskId: string) => {
    const h = pollHandles.current.get(taskId);
    if (h) { clearInterval(h); pollHandles.current.delete(taskId); }
  }, []);

  const startGeneration = useCallback(
    async (chainFilter?: string, dry = false, segmentFilter?: string) => {
      if (running) return;
      setRunning(true);
      setActiveChain(chainFilter ?? 'all');
      const providerLabel = provider === 'wan3' ? '万相3.0' : 'H3';
      appendLog(
        `${dry ? '校验（不调用 API、不计费）' : '开始生成'}${segmentFilter ? ' 镜段' + segmentFilter : chainFilter ? ' 链' + chainFilter : ' 全集'}（${resolution} · ${providerLabel}）`,
      );

      const url = new URL('/api/produce', window.location.href);
      url.searchParams.set('work', workId);
      url.searchParams.set('episode', epId);
      url.searchParams.set('resolution', resolution);
      url.searchParams.set('provider', provider);
      if (chainFilter) url.searchParams.set('chain', chainFilter);
      if (segmentFilter) url.searchParams.set('segment', segmentFilter);
      if (dry) url.searchParams.set('dry', '1');

      const es = new EventSource(url.toString());

      es.addEventListener('start', (e) => {
        try { appendLog(JSON.parse((e as MessageEvent).data).message ?? (e as MessageEvent).data); }
        catch { appendLog((e as MessageEvent).data); }
      });

      es.addEventListener('seg:start', (e) => {
        const d = JSON.parse((e as MessageEvent).data) as {
          chain: string; seg: string; mode: string; duration: number;
          media?: string[]; promptChars?: number;
        };
        updateSeg(d.chain, d.seg, { status: 'running', h3Status: undefined, taskId: undefined });
        appendLog(`开始 ${d.seg}（${d.mode} ${d.duration}s，提示词 ${d.promptChars ?? '?'} 字）`);
        // media 是真正发给 API 的素材清单，和页面上预览的图片对不上就是配置错了
        if (d.media?.length) appendLog(`  素材 ${d.media.join('、')}`);
      });

      // 任务刚提交，task_id 已知 → 启动轮询
      es.addEventListener('seg:task', (e) => {
        const d = JSON.parse((e as MessageEvent).data) as { chain: string; seg: string; taskId: string };
        updateSeg(d.chain, d.seg, { taskId: d.taskId, h3Status: 'Queueing' });
        appendLog(`任务已提交 ${d.seg} → task=${d.taskId}`);
        startPoll(d.taskId, d.chain, d.seg, provider);
      });

      es.addEventListener('seg:done', (e) => {
        const d = JSON.parse((e as MessageEvent).data) as { chain: string; seg: string; elapsed: number; path: string };
        updateSeg(d.chain, d.seg, { status: 'done', elapsed: d.elapsed, videoPath: d.path, h3Status: 'Success' });
        appendLog(`完成 ${d.seg}（${d.elapsed}s）`);
        // 找到对应 taskId 停掉轮询（可能已自停）
        setChains((prev) => {
          const chain = prev.find((c) => c.name === d.chain);
          const s = chain?.segs.find((x) => x.id === d.seg);
          if (s?.taskId) stopPoll(s.taskId);
          return prev;
        });
      });

      es.addEventListener('seg:skip', (e) => {
        const d = JSON.parse((e as MessageEvent).data) as { chain: string; seg: string; reason?: string };
        // 校验模式下每段都会以 skip 收尾，那不代表「已完成」——不许让它把进度条填满。
        // 但「视频已存在」这种 skip 无论哪个模式都是真的已完成。
        const reallyDone = !dry || d.reason === '视频已存在';
        updateSeg(d.chain, d.seg, { status: reallyDone ? 'skipped' : 'idle' });
        appendLog(`${reallyDone ? '跳过' : '校验通过'} ${d.seg}${d.reason ? `（${d.reason}）` : ''}`);
      });

      es.addEventListener('seg:warn', (e) => {
        const d = JSON.parse((e as MessageEvent).data) as { chain: string; seg: string; warning: string };
        appendLog(`警告 ${d.seg}: ${d.warning}`);
      });

      es.addEventListener('seg:fail', (e) => {
        const d = JSON.parse((e as MessageEvent).data) as { chain: string; seg: string; error: string };
        updateSeg(d.chain, d.seg, { status: 'failed', errorMsg: d.error, h3Status: 'Fail' });
        appendLog(`失败 ${d.seg}: ${d.error}`);
        setChains((prev) => {
          const chain = prev.find((c) => c.name === d.chain);
          const s = chain?.segs.find((x) => x.id === d.seg);
          if (s?.taskId) stopPoll(s.taskId);
          return prev;
        });
      });

      es.addEventListener('done', () => {
        appendLog(dry ? '校验结束' : '全部完成');
        setRunning(false);
        setActiveChain(null);
        es.close();
      });

      es.onerror = () => {
        appendLog('连接断开');
        setRunning(false);
        setActiveChain(null);
        es.close();
      };
    },
    [running, resolution, provider, workId, epId, updateSeg, appendLog, startPoll, stopPoll],
  );

  const toggleChain = (name: string) => {
    setChains((prev) => prev.map((c) => (c.name === name ? { ...c, expanded: !c.expanded } : c)));
  };

  /**
   * 生成按钮先落到这里，过完确认弹窗才真正开跑。
   * 校验（dry run）不走这条路——它不花钱，多一次点击只是碍事。
   */
  const requestRun = useCallback(
    (chain?: string, segmentId?: string) => {
      if (running) return;
      const chainSegs = chain ? chains.find((c) => c.name === chain)?.segs ?? [] : chains.flatMap((c) => c.segs);
      const scope = segmentId ? chainSegs.filter((s) => s.id === segmentId) : chainSegs;
      if (scope.length === 0) return;
      setPending({
        title: segmentId ? `生成镜段 ${segmentId}` : chain ? `生成链 ${chain}` : '生成全集',
        chain,
        segment: segmentId,
        segs: scope,
      });
    },
    [running, chains],
  );

  return (
    <div className="min-h-[100dvh] bg-neutral-950 text-neutral-100 font-sans">
      {/* 顶栏 */}
      <header className="border-b border-neutral-800 px-6 py-3 flex flex-wrap items-center gap-x-3 gap-y-2">
        <a href="/" className="text-neutral-500 hover:text-neutral-300 transition-colors flex items-center gap-1.5 text-sm">
          <ArrowLeft size={14} />
        </a>
        <FilmStrip size={20} weight="duotone" className="text-amber-400" />
        <span className="font-medium tracking-tight">{workId}</span>
        <span className="text-xs text-neutral-500 font-mono">{epTitle || epId}</span>
        <span className="text-xs text-neutral-600 font-mono">{totalSegs} 段 · {totalSec}s</span>
        {episodes.length > 0 && (
          <nav className="flex max-w-full flex-wrap items-center gap-1.5" aria-label="分集导航">
            {episodes.map((episode) => (
              <Link
                key={episode.epId}
                href={`/works/${encodeURIComponent(workId)}/${episode.epId}`}
                className={`rounded-full border px-2.5 py-1 text-[11px] transition-colors ${
                  episode.epId === epId
                    ? 'border-amber-400/60 bg-amber-400/10 text-amber-300'
                    : 'border-neutral-800 text-neutral-500 hover:border-neutral-600 hover:text-neutral-200'
                }`}
              >
                {episode.epId} · {episode.title}
              </Link>
            ))}
          </nav>
        )}

        <div className="ml-auto flex flex-wrap items-center gap-x-3 gap-y-2">
          {/* 视频模型选择 */}
          <span className="text-xs text-neutral-500">模型</span>
          {(['wan3', 'h3'] as const).map((p) => (
            <button
              key={p}
              onClick={() => {
                setProvider(p);
                // 切换模型时重置分辨率为对应默认值
                setResolution(p === 'wan3' ? '480P' : '768p');
              }}
              className={`text-xs px-3 py-1 rounded-full border transition-all ${
                provider === p
                  ? 'bg-amber-400 text-neutral-950 border-amber-400 font-medium'
                  : 'border-neutral-700 text-neutral-400 hover:border-neutral-500 hover:text-neutral-200'
              }`}
            >
              {p === 'h3' ? 'MiniMax H3' : '万相 3.0'}
            </button>
          ))}
          <span className="text-neutral-700 text-xs">|</span>
          <span className="text-xs text-neutral-500">分辨率</span>
          {(provider === 'wan3'
            ? (['480P', '720P', '1080P'] as const)
            : (['768p', '1440p'] as const)
          ).map((r) => (
            <button
              key={r}
              onClick={() => setResolution(r)}
              className={`text-xs px-3 py-1 rounded-full border transition-all ${
                resolution === r
                  ? 'bg-neutral-600 text-neutral-100 border-neutral-500 font-medium'
                  : 'border-neutral-700 text-neutral-400 hover:border-neutral-500 hover:text-neutral-200'
              }`}
            >
              {r}
            </button>
          ))}
        </div>
      </header>

      {loadErr && (
        <div className="mx-6 mt-4 flex items-start gap-2 text-xs text-red-400 bg-red-400/5 border border-red-400/20 rounded-xl px-4 py-3">
          <WarningCircle size={14} weight="fill" className="shrink-0 mt-0.5" />
          <span className="font-mono break-all">{loadErr}</span>
        </div>
      )}

      {assetSummary && (
        <section className="mx-auto max-w-[1800px] px-6 pt-5">
          <div className={`rounded-xl border px-4 py-3 text-xs ${assetSummary.status === 'ready' ? 'border-emerald-400/20 bg-emerald-400/5 text-emerald-300' : 'border-amber-400/20 bg-amber-400/5 text-amber-300'}`}>
            <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
              <span className="font-medium">素材状态：{assetSummary.status === 'ready' ? '已就绪' : '未完成'}</span>
              <span>静态图片 {assetSummary.staticImages} 张</span>
              <span>关键帧 {assetSummary.requiredFrames.present}/{assetSummary.requiredFrames.total}</span>
              {assetSummary.issues.length > 0 && <span>内容/命名问题 {assetSummary.issues.length} 项</span>}
            </div>
            {assetSummary.missingFrames.length > 0 && (
              <p className="mt-1 text-amber-200/70">缺失关键帧：{assetSummary.missingFrames.join('、')}</p>
            )}
            {assetSummary.issues.map((item) => (
              <p key={item.name} className="mt-1 text-red-300/80">{item.name}：{item.issue}</p>
            ))}
          </div>
        </section>
      )}

      {assetCatalog.length > 0 && (
        <section className="mx-auto max-w-[1800px] px-6 pt-5">
          <div className="rounded-2xl border border-neutral-800 bg-neutral-900/70 px-5 py-4">
            <div className="mb-3 flex flex-wrap items-baseline gap-3">
              <span className="text-sm text-neutral-300">本集素材总览</span>
              <span className="font-mono text-[11px] text-neutral-600">
                {assetCatalog.filter((asset) => asset.exists && !asset.issue).length}/{assetCatalog.length} 个可用文件
              </span>
              <span className="text-[11px] text-neutral-600">按镜段依赖去重 · 向右滑动查看更多</span>
            </div>
            <div className="flex snap-x snap-mandatory gap-3 overflow-x-auto pb-2 overscroll-x-contain [scrollbar-width:thin]">
              {assetCatalog.map((asset) => (
                <div key={`${asset.role}:${asset.name}`} className="w-32 shrink-0 snap-start">
                  <ImageCard dep={asset} workId={workId} epId={epId} compact />
                </div>
              ))}
            </div>
          </div>
        </section>
      )}

      <div className="max-w-[1800px] mx-auto px-6 py-6 grid grid-cols-1 lg:grid-cols-[300px_minmax(0,1fr)] xl:grid-cols-[300px_minmax(0,1fr)_320px] gap-6 items-start">
        {/* ── 左栏：进度 + 生成入口 + 段列表 ── */}
        <div className="space-y-3 lg:sticky lg:top-6">
          <div className="bg-neutral-900 rounded-2xl p-5 border border-neutral-800">
            <div className="flex items-center justify-between mb-3">
              <span className="text-sm text-neutral-400">总进度</span>
              <span className="text-xs font-mono text-neutral-500">{doneSegs}/{totalSegs} 段</span>
            </div>
            <div className="h-1.5 bg-neutral-800 rounded-full overflow-hidden">
              <div
                className="h-full bg-gradient-to-r from-amber-500 to-emerald-400 rounded-full transition-all duration-500"
                style={{ width: `${totalSegs ? (doneSegs / totalSegs) * 100 : 0}%` }}
              />
            </div>
            {unitPrice !== undefined && pendingSec > 0 && (
              <p className="mt-3 text-[11px] text-neutral-500 leading-relaxed">
                待生成 {pendingSec}s × {unitPrice} 元/s ≈
                <span className="text-neutral-300 font-mono"> {(pendingSec * unitPrice).toFixed(1)} 元</span>
                <span className="text-neutral-700">（标准版；重出损耗按 1.5-2 倍估）</span>
              </p>
            )}
            {failedSegs > 0 && (
              <p className="mt-2 text-xs text-red-400 flex items-center gap-1">
                <WarningCircle size={12} weight="fill" />
                {failedSegs} 段失败，重跑自动跳过已有的
              </p>
            )}
          </div>

          <button
            onClick={() => requestRun()}
            disabled={running}
            className={`w-full flex items-center justify-center gap-2 py-3 rounded-2xl text-sm font-medium transition-all active:scale-[0.98] ${
              running
                ? 'bg-neutral-800 text-neutral-500 cursor-not-allowed'
                : 'bg-amber-400 text-neutral-950 hover:bg-amber-300'
            }`}
          >
            {running && activeChain === 'all'
              ? <><ArrowClockwise size={16} className="animate-spin" />生成中…</>
              : <><Lightning size={16} weight="fill" />生成全集（{totalSegs} 段）</>}
          </button>

          {/* dry run：走一遍完整的模式/时长/素材编排但不调 API，零成本 */}
          <button
            onClick={() => startGeneration(undefined, true)}
            disabled={running}
            className="w-full flex items-center justify-center gap-2 py-2 rounded-xl text-xs border border-neutral-700 text-neutral-400 hover:border-neutral-500 hover:text-neutral-200 transition-all disabled:opacity-40"
          >
            <MagnifyingGlass size={13} />
            只校验，不生成（不花钱）
          </button>

          {chains.map((chain) => {
            const chainDone = chain.segs.filter((s) => s.status === 'done' || s.status === 'skipped').length;
            const isActive = running && activeChain === chain.name;
            const isSelected = chain.segs.some((s) => s.id === selected);
            const segRange = chain.segs.length > 1
              ? `${chain.segs[0].id}-${chain.segs[chain.segs.length - 1].id}`
              : chain.segs[0]?.id ?? '';
            return (
              <div
                key={chain.name}
                className={`bg-neutral-900 rounded-2xl border overflow-hidden transition-colors ${
                  isSelected ? 'border-neutral-600' : 'border-neutral-800'
                }`}
              >
                <div className="flex items-center gap-1 px-3 py-2.5">
                  <button
                    onClick={() => toggleChain(chain.name)}
                    title={chain.expanded ? '收起' : '展开'}
                    className="shrink-0 p-1 text-neutral-500 hover:text-neutral-200 transition-colors"
                  >
                    {chain.expanded ? <CaretDown size={13} /> : <CaretRight size={13} />}
                  </button>
                  {/* 点链名＝选中该链第一段。之前这里只绑了折叠，所以点链标题中栏不动。 */}
                  <button
                    onClick={() => {
                      const first = chain.segs[0];
                      if (!first) return;
                      setSelected(first.id);
                      setChains((prev) => prev.map((c) => (c.name === chain.name ? { ...c, expanded: true } : c)));
                    }}
                    className="flex-1 flex items-baseline gap-2 text-left min-w-0"
                  >
                    <span className="text-xs font-mono font-medium shrink-0">{segRange}</span>
                    <span className="text-[10px] text-neutral-600 truncate">{chain.name}</span>
                    <span className="ml-auto text-[11px] font-mono text-neutral-600 shrink-0">{chainDone}/{chain.segs.length}</span>
                  </button>
                  <button
                    onClick={() => requestRun(chain.name)}
                    disabled={running}
                    title="生成此链"
                    className={`shrink-0 p-1.5 rounded-full transition-all active:scale-[0.97] ${
                      isActive ? 'text-amber-400' : 'text-neutral-500 hover:text-neutral-200'
                    }`}
                  >
                    {isActive
                      ? <ArrowClockwise size={12} className="animate-spin" />
                      : <Play size={12} weight="fill" />}
                  </button>
                </div>
                {chain.expanded && (
                  <div className="border-t border-neutral-800 divide-y divide-neutral-800/60">
                    {chain.segs.map((s) => (
                      <SegRow
                        key={s.id}
                        seg={s}
                        active={s.id === selected}
                        onSelect={() => setSelected(s.id)}
                        onRun={() => requestRun(chain.name, s.id)}
                        disabled={running}
                      />
                    ))}
                  </div>
                )}
              </div>
            );
          })}
        </div>

        {/* ── 中栏：选中段的图片 + 提示词 + 视频 ── */}
        <div className="min-w-0">
          {!seg ? (
            <div className="flex flex-col items-center justify-center h-64 text-neutral-700">
              <FileText size={32} weight="thin" className="mb-3" />
              <p className="text-sm">选择左侧某段查看提示词与图片</p>
            </div>
          ) : (
            <SegDetail seg={seg} workId={workId} epId={epId} />
          )}
        </div>

        {/* ── 右栏：日志 + 输出目录 ── */}
        <div className="space-y-3 xl:sticky xl:top-6">
          <div className="bg-neutral-900 rounded-2xl border border-neutral-800 overflow-hidden">
            <div className="flex items-center justify-between px-4 py-2.5 border-b border-neutral-800">
              <span className="text-xs text-neutral-400 font-medium">运行日志</span>
              <button onClick={() => setLog([])} className="text-xs text-neutral-600 hover:text-neutral-400 transition-colors">清空</button>
            </div>
            <div className="h-[calc(100vh-260px)] min-h-[240px] overflow-y-auto p-3 space-y-1 font-mono">
              {log.length === 0 ? (
                <p className="text-xs text-neutral-700 text-center pt-8">尚未运行</p>
              ) : (
                [...log].reverse().map((line, i) => (
                  <p
                    key={i}
                    className={`text-[11px] leading-relaxed break-all ${
                      line.includes('失败') ? 'text-red-400'
                      : line.includes('警告') ? 'text-amber-400'
                      : line.includes('完成') ? 'text-emerald-400'
                      : line.includes('跳过') ? 'text-neutral-500'
                      : line.includes('轮询') ? 'text-sky-400/70'
                      : line.includes('素材') ? 'text-neutral-600'
                      : 'text-neutral-400'
                    }`}
                  >
                    {line}
                  </p>
                ))
              )}
            </div>
          </div>
          <div className="bg-neutral-900 rounded-2xl border border-neutral-800 p-4">
            <div className="flex items-start gap-3">
              <Folder size={15} className="text-neutral-500 shrink-0 mt-0.5" />
              <div className="min-w-0">
                <p className="text-xs text-neutral-400 font-medium mb-1">视频输出目录</p>
                <p className="text-[11px] text-neutral-600 font-mono break-all leading-relaxed">
                  {epDir ? `${epDir}/media/videos/` : '—'}
                </p>
              </div>
            </div>
          </div>
        </div>
      </div>

      {pending && (
        <ConfirmRun
          run={pending}
          resolution={resolution}
          unitPrice={unitPrice}
          providerLabel={provider === 'wan3' ? '万相 3.0 标准版' : 'MiniMax H3'}
          onCancel={() => setPending(null)}
          onConfirm={() => {
            const chain = pending.chain;
            const segment = pending.segment;
            setPending(null);
            startGeneration(chain, false, segment);
          }}
        />
      )}
    </div>
  );
}

// ─── 左栏的一行段 ─────────────────────────────────────────────────────────
function SegRow({
  seg, active, onSelect, onRun, disabled,
}: {
  seg: Seg; active: boolean; onSelect: () => void; onRun: () => void; disabled: boolean;
}) {
  const missing = seg.deps.filter((d) => isRequiredFrame(d) && !d.exists).length;
  const meta = modeMeta(seg.mode);
  return (
    <div
      className={`flex items-center gap-2 px-4 py-2 text-xs cursor-pointer transition-colors ${
        active ? 'bg-neutral-800' : seg.status === 'running' ? 'bg-amber-400/5' : 'hover:bg-neutral-800/40'
      }`}
      onClick={onSelect}
    >
      <SegIcon status={seg.status} h3Status={seg.h3Status} size={13} />
      <span className="w-8 font-mono text-neutral-300 shrink-0">{seg.id}</span>
      <span className={`font-mono text-[10px] rounded px-1.5 py-0.5 shrink-0 ${meta.cls}`}>{meta.label}</span>
      <span className="font-mono text-[10px] text-neutral-600 shrink-0">{seg.durationSec}s</span>
      <span className="ml-auto flex items-center gap-1.5 shrink-0">
        {seg.videoPath && (
          <span title="已出片"><VideoCamera size={12} className="text-emerald-400" /></span>
        )}
        {missing > 0 && (
          <span title="缺少必要帧"><Warning size={12} className="text-red-400" /></span>
        )}
        {seg.requiresVoiceRef && !seg.hasVoiceRef && (
          <span title="缺音色样本，会被拒跑"><Microphone size={12} className="text-amber-400" /></span>
        )}
        {seg.inheritFrom && (
          <span title={`首帧继承 ${seg.inheritFrom}`}><LinkIcon size={11} className="text-amber-400/70" /></span>
        )}
        <button
          onClick={(e) => { e.stopPropagation(); onRun(); }}
          disabled={disabled}
          title={
            seg.status === 'idle'
              ? '生成此镜段'
              : seg.status === 'failed'
                ? '重跑此镜段'
                : '重新生成此镜段'
          }
          aria-label={seg.status === 'idle' ? `生成${seg.id}` : `重新生成${seg.id}`}
          className={`transition-colors ${
            seg.status === 'failed'
              ? 'text-neutral-500 hover:text-red-400'
              : 'text-neutral-600 hover:text-amber-400'
          } disabled:opacity-30`}
        >
          {seg.status === 'idle' ? <Play size={12} weight="fill" /> : <ArrowClockwise size={12} />}
        </button>
        {seg.status === 'running'
          ? <span className="text-[10px] text-amber-400">{statusText(seg.status, seg.h3Status)}</span>
          : seg.elapsed !== undefined
            ? <span className="font-mono text-[10px] text-neutral-700">{seg.elapsed}s</span>
            : null}
      </span>
    </div>
  );
}

// ─── 中栏详情 ─────────────────────────────────────────────────────────────
function SegDetail({ seg, workId, epId }: { seg: Seg; workId: string; epId: string }) {
  const [showNote, setShowNote] = useState(false);
  const [copied, setCopied] = useState(false);
  const meta = modeMeta(seg.mode);

  const frames = seg.deps.filter(isRequiredFrame);
  const refs = seg.deps.filter((d) => d.role === 'reference_image');
  const visualRefs = seg.deps.filter((d) => d.role === 'visual_reference');
  const aux = seg.deps.filter((d) => d.role === 'prop' || d.role === 'composition');
  const sources = seg.deps.filter((d) => d.role === 'source');
  const missing = frames.filter((d) => !d.exists);

  const copy = () => {
    navigator.clipboard.writeText(seg.prompt);
    setCopied(true);
    setTimeout(() => setCopied(false), 1200);
  };

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-3 pb-3 border-b border-neutral-800">
        <span className="text-2xl font-mono font-medium tracking-tighter">{seg.id}</span>
        <span className={`text-xs px-2.5 py-1 rounded-full font-mono ${meta.cls}`}>{meta.label}</span>
        <span className="text-xs text-neutral-500 font-mono">{seg.durationSec}s</span>
        <span className="text-xs text-neutral-600">链 {seg.chainName}</span>
        <span className="ml-auto flex items-center gap-1.5 text-xs">
          <SegIcon status={seg.status} h3Status={seg.h3Status} size={13} />
          <span className="text-neutral-500">{statusText(seg.status, seg.h3Status)}</span>
        </span>
      </div>

      {/* 跑之前就能看出来的三类拦路问题 */}
      {missing.length > 0 && (
        <Banner tone="red">
          缺 {missing.length} 张必要帧：{missing.map((d) => d.name).join('、')}
        </Banner>
      )}
      {seg.requiresVoiceRef && !seg.hasVoiceRef && (
        <Banner tone="amber">
          <Microphone size={13} className="shrink-0" />
          本段声明了 requiresVoiceRef 但 wan3ReferenceAudioUrls 为空 —— /api/produce 会直接拒跑，先截音色样本并上传公网 URL
        </Banner>
      )}
      {seg.inheritFrom && (
        <Banner tone={seg.prevHasActualLastFrame ? 'amber' : 'neutral'}>
          <LinkIcon size={13} className="shrink-0" />
          {seg.prevHasActualLastFrame
            ? `首帧将使用 ${seg.inheritFrom} 的真实尾帧（链式衔接）`
            : `声明继承 ${seg.inheritFrom} 的尾帧，但它还没生成，本次会退回用定稿首帧`}
        </Banner>
      )}
      {seg.status === 'failed' && seg.errorMsg && (
        <Banner tone="red"><span className="font-mono break-all">{seg.errorMsg}</span></Banner>
      )}

      {/* 图片在左、视频在右：核对的动作就是拿首尾帧跟成片比，两边要能同时看见。 */}
      <div className="grid grid-cols-1 xl:grid-cols-[minmax(0,1fr)_minmax(0,340px)] gap-5 items-start">
        <div className="space-y-4 min-w-0">
          {frames.length > 0 && (
            <div>
              <GroupTitle>关键帧<Hint>API 入参，像素锁死</Hint></GroupTitle>
              <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
                {frames.map((d) => <ImageCard key={d.name} dep={d} workId={workId} epId={epId} />)}
              </div>
            </div>
          )}

          {refs.length > 0 && (
            <div>
              <GroupTitle>
                参考素材
                <Hint>API 入参 reference_image，图号即上传顺序，须与提示词里的「图n」一一对应</Hint>
              </GroupTitle>
              <div className="grid grid-cols-3 sm:grid-cols-4 gap-2">
                {refs.map((d) => <ImageCard key={d.name} dep={d} workId={workId} epId={epId} compact />)}
              </div>
            </div>
          )}

          {visualRefs.length > 0 && (
            <div>
              <GroupTitle>视觉参考<Hint>首帧模式下用于核对和制作，不随视频请求上传</Hint></GroupTitle>
              <div className="grid grid-cols-3 sm:grid-cols-4 gap-2">
                {visualRefs.map((d) => <ImageCard key={d.name} dep={d} workId={workId} epId={epId} compact />)}
              </div>
            </div>
          )}

          {aux.length > 0 && (
            <div>
              <GroupTitle>道具卡 / 构图参考<Hint>出图时的素材，不进 API 请求</Hint></GroupTitle>
              <div className="grid grid-cols-3 sm:grid-cols-4 gap-2">
                {aux.map((d) => <ImageCard key={d.name} dep={d} workId={workId} epId={epId} compact />)}
              </div>
            </div>
          )}

          {sources.length > 0 && (
            <div>
              <GroupTitle>
                首帧制作源素材
                <Hint>用于制作当前首帧，不与 first_frame 同时上传</Hint>
              </GroupTitle>
              <div className="grid grid-cols-3 sm:grid-cols-4 gap-2">
                {sources.map((d) => <ImageCard key={d.name} dep={d} workId={workId} epId={epId} compact />)}
              </div>
            </div>
          )}
        </div>

        <div className="min-w-0 xl:sticky xl:top-6">
          <GroupTitle>输出视频</GroupTitle>
          {seg.videoPath
            ? <VideoPane path={seg.videoPath} />
            : (
              <div className="flex flex-col items-center justify-center aspect-[9/16] max-h-[60vh] bg-neutral-900 border border-neutral-800 rounded-2xl text-neutral-700 gap-2">
                <VideoCamera size={24} weight="thin" />
                <span className="text-xs">这一段还没出片</span>
              </div>
            )}
        </div>
      </div>

      <div>
        <GroupTitle>
          提示词
          <Hint>{seg.prompt.length} 字 · prompt_extend 关闭，逐字发送</Hint>
        </GroupTitle>
        {seg.prompt ? (
          <div className="relative">
            <button
              onClick={copy}
              className="absolute top-3 right-3 text-[10px] text-neutral-500 hover:text-neutral-300 border border-neutral-700 rounded px-2 py-1 transition-colors bg-neutral-900"
            >
              {copied ? '已复制' : '复制'}
            </button>
            <pre className="text-[12px] font-mono leading-relaxed text-neutral-300 bg-neutral-900 border border-neutral-800 rounded-2xl p-5 whitespace-pre-wrap max-h-[50vh] overflow-y-auto">
              <PromptText prompt={seg.prompt} deps={seg.deps} workId={workId} epId={epId} />
            </pre>
          </div>
        ) : (
          <div className="flex items-center justify-center h-24 text-neutral-700 text-sm bg-neutral-900 rounded-2xl border border-neutral-800">
            未找到 wan3Prompt —— 这一段会被 /api/produce 直接报错拦下
          </div>
        )}
      </div>

      {seg.note && (
        <div>
          <button
            onClick={() => setShowNote((v) => !v)}
            className="flex items-center gap-1.5 text-[11px] text-neutral-500 hover:text-neutral-300 transition-colors"
          >
            {showNote ? <CaretDown size={11} /> : <CaretRight size={11} />}
            设计说明 / 已知残留
          </button>
          {showNote && (
            <p className="mt-2 text-[11px] leading-relaxed text-neutral-500 bg-neutral-900 border border-neutral-800 rounded-2xl p-4 whitespace-pre-wrap">
              {seg.note}
            </p>
          )}
        </div>
      )}
    </div>
  );
}

// ─── 生成确认弹窗 ─────────────────────────────────────────────────────────
/**
 * 生成是要花钱的、且已出片的段会被后端按幂等跳过。所以这个弹窗必须把三件事说清楚：
 * 真正会跑哪几段、花多少钱、有哪几段会被拦下或跳过。
 */
function ConfirmRun({
  run, resolution, unitPrice, providerLabel, onConfirm, onCancel,
}: {
  run: PendingRun;
  resolution: string;
  unitPrice?: number;
  providerLabel: string;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const skipped = run.segs.filter((s) => s.status === 'done' || s.status === 'skipped');
  const fresh = run.segs.filter((s) => s.status !== 'done' && s.status !== 'skipped');
  const sec = fresh.reduce((n, s) => n + s.durationSec, 0);
  const blocked = fresh.filter(
    (s) => s.deps.some((d) => isRequiredFrame(d) && !d.exists) || (s.requiresVoiceRef && !s.hasVoiceRef),
  );

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-6 bg-neutral-950/80 backdrop-blur-sm" onClick={onCancel}>
      <div
        className="w-full max-w-md bg-neutral-900 border border-neutral-700 rounded-2xl p-6 space-y-4"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-2">
          <Lightning size={18} weight="fill" className="text-amber-400" />
          <span className="text-sm font-medium">{run.title}</span>
        </div>

        <div className="space-y-2 text-xs text-neutral-400 leading-relaxed">
          <p>
            模型 <span className="text-neutral-200">{providerLabel}</span>
            ，分辨率 <span className="text-neutral-200">{resolution}</span>
          </p>
          <p>
            实际会跑 <span className="text-neutral-200 font-mono">{fresh.length}</span> 段，共
            <span className="text-neutral-200 font-mono"> {sec}</span> 秒
            {fresh.length > 0 && (
              <span className="text-neutral-600">（{fresh.map((s) => s.id).join('、')}）</span>
            )}
          </p>
          {unitPrice !== undefined && sec > 0 && (
            <p className="text-amber-400">
              预计花费 <span className="font-mono">{(sec * unitPrice).toFixed(1)}</span> 元
              <span className="text-neutral-600">（{unitPrice} 元/秒，失败不计费）</span>
            </p>
          )}
          {skipped.length > 0 && (
            <p className="text-neutral-500">
              {skipped.length} 段已有视频会被跳过（{skipped.map((s) => s.id).join('、')}）——
              <span className="text-neutral-400">想重出必须先删掉对应的 mp4</span>
            </p>
          )}
          {blocked.length > 0 && (
            <p className="text-red-400">
              {blocked.map((s) => s.id).join('、')} 素材不全，会在跑之前被拦下
            </p>
          )}
          {fresh.length === 0 && (
            <p className="text-neutral-500">没有任何段需要生成，点确认也不会有动作。</p>
          )}
        </div>

        <div className="flex gap-2 pt-1">
          <button
            onClick={onCancel}
            className="flex-1 py-2 rounded-xl text-xs border border-neutral-700 text-neutral-300 hover:border-neutral-500 transition-all"
          >
            取消
          </button>
          <button
            onClick={onConfirm}
            className="flex-1 py-2 rounded-xl text-xs font-medium bg-amber-400 text-neutral-950 hover:bg-amber-300 transition-all active:scale-[0.98]"
          >
            确认生成
          </button>
        </div>
      </div>
    </div>
  );
}

// ─── 小件 ─────────────────────────────────────────────────────────────────
/**
 * 视频预览 + 清晰度标识。分辨率从 `loadedmetadata` 里读真实像素，
 * 不用顶栏那个 resolution 选项——那个是「下次要跑什么」，标识要答的是「这个文件是什么」。
 */
function VideoPane({ path }: { path: string }) {
  const [dim, setDim] = useState<{ w: number; h: number } | null>(null);
  return (
    <div className="relative">
      <video
        src={`/api/video?path=${encodeURIComponent(path)}`}
        controls
        onLoadedMetadata={(e) => {
          const v = e.currentTarget;
          setDim({ w: v.videoWidth, h: v.videoHeight });
        }}
        className="w-full rounded-2xl bg-black border border-neutral-800 max-h-[60vh]"
      />
      {dim && (
        <span className="absolute top-2 left-2 flex items-center gap-1.5 text-[10px] font-mono px-2 py-1 rounded-md bg-neutral-950/80 border border-neutral-700 backdrop-blur-sm">
          <span className="text-amber-400 font-medium">{resolutionTier(dim.w, dim.h)}</span>
          <span className="text-neutral-500">{dim.w}×{dim.h}</span>
        </span>
      )}
    </div>
  );
}

function GroupTitle({ children }: { children: React.ReactNode }) {
  return <p className="text-[11px] text-neutral-500 mb-2 flex flex-wrap items-baseline gap-2">{children}</p>;
}

function Hint({ children }: { children: React.ReactNode }) {
  return <span className="text-neutral-700 font-normal">{children}</span>;
}

function Banner({ tone, children }: { tone: 'red' | 'amber' | 'neutral'; children: React.ReactNode }) {
  const cls = {
    red: 'border-red-400/20 bg-red-400/5 text-red-400',
    amber: 'border-amber-400/20 bg-amber-400/5 text-amber-400',
    neutral: 'border-neutral-800 bg-neutral-900 text-neutral-500',
  }[tone];
  return (
    <div className={`flex items-start gap-2 text-xs leading-relaxed px-3 py-2 rounded-lg border ${cls}`}>
      {children}
    </div>
  );
}

function PromptText({
  prompt, deps, workId, epId,
}: { prompt: string; deps: DepItem[]; workId: string; epId: string }) {
  const byToken = new Map(deps.filter((dep) => dep.token).map((dep) => [dep.token, dep]));
  // 先按 @图片N 切，非引用片段再按「对白」切：台词用独立颜色高亮，方便逐句核对
  const renderText = (text: string, keyPrefix: string): ReactNode[] =>
    text.split(/(「[^」]*」)/g).map((piece, i) =>
      piece.startsWith('「') && piece.endsWith('」') ? (
        <span key={`${keyPrefix}-${i}`} className="rounded bg-emerald-500/15 px-0.5 text-emerald-300">
          {piece}
        </span>
      ) : (
        <Fragment key={`${keyPrefix}-${i}`}>{piece}</Fragment>
      ),
    );
  return (
    <>
      {prompt.split(/(@图片\d+)/g).map((part, index) => {
        const dep = byToken.get(part);
        if (!dep) return renderText(part, String(index));
        const href = dep.previewUrl ?? `/api/images/${encodeURIComponent(workId)}/${encodeURIComponent(epId)}/${encodeURIComponent(dep.name)}`;
        return dep.exists && dep.previewUrl ? (
          <a
            key={index}
            href={href}
            target="_blank"
            rel="noreferrer"
            title={`${part}：${dep.name}`}
            className="text-amber-300 underline decoration-amber-300/40 underline-offset-2 hover:text-amber-200"
          >
            {part}
          </a>
        ) : (
          <span key={index} title={dep.issue ?? '图片不可用'} className="text-red-400 underline decoration-red-400/40 underline-offset-2">
            {part}
          </span>
        );
      })}
    </>
  );
}

function ImageCard({
  dep, workId, epId, compact = false,
}: {
  dep: DepItem; workId: string; epId: string; compact?: boolean;
}) {
  const [err, setErr] = useState(false);
  const src = dep.previewUrl ?? `/api/images/${encodeURIComponent(workId)}/${encodeURIComponent(epId)}/${encodeURIComponent(dep.name)}`;
  const meta = DEP_META[dep.role];
  return (
    <div className="space-y-1.5">
      <a
        href={src}
        target="_blank"
        rel="noreferrer"
        className={`block relative bg-neutral-900 border border-neutral-800 rounded-xl overflow-hidden hover:border-neutral-600 transition-colors ${
          compact ? 'aspect-[3/4]' : 'aspect-[9/16]'
        }`}
      >
        {dep.exists && !err ? (
          <img src={src} alt={dep.name} className="w-full h-full object-cover" onError={() => setErr(true)} />
        ) : (
          <div className="flex flex-col items-center justify-center h-full gap-2">
            {dep.exists
              ? <ImageIcon size={20} className="text-neutral-700" />
              : <XCircle size={20} weight="fill" className="text-red-500/60" />}
            <span className="text-[9px] text-neutral-700 text-center px-1">{dep.exists ? '加载失败' : '文件不存在'}</span>
          </div>
        )}
        <span className={`absolute top-1.5 left-1.5 text-[9px] px-1.5 py-0.5 rounded border font-medium ${meta.cls}`}>
          {dep.label ? `${dep.label} ${meta.label}` : meta.label}
        </span>
        {dep.exists && !err && (
          <span className="absolute top-1.5 right-1.5">
            <CheckCircle size={12} weight="fill" className="text-emerald-400" />
          </span>
        )}
      </a>
      <p
        className="text-[9px] text-neutral-600 font-mono truncate px-0.5"
        title={dep.name}
      >
        {dep.name}
      </p>
      {dep.issue && <p className="text-[9px] leading-tight text-red-400/80" title={dep.issue}>{dep.issue}</p>}
    </div>
  );
}
