#!/usr/bin/env node
/**
 * 导出离线快照版 inde.html（不需要任何服务，双击即可浏览）。
 *
 * 原理：把 /api/works 和每一集 /api/segments 的返回值全部内嵌进
 * public/inde.html 的副本（注入 window.__SNAPSHOT__），图片与视频不改成
 * base64（全量素材 500MB+，塞不进单文件），而是解析出相对路径直接引用
 * storage/ 里的原文件。产物写到项目根目录 ./inde.html，**必须保持在
 * 项目根目录**（与 storage/ 同级）才能加载素材。
 *
 * 前置：dev server 已在运行（npm run dev）。
 * 用法：node scripts/export-inde.mjs
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { readdirSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';

const BASE = process.env.INDE_BASE ?? 'http://localhost:3000';
const ROOT = resolve(process.cwd());
const IMG_EXT = new Set(['.png', '.jpg', '.jpeg', '.webp']);

async function getJson(url) {
  const res = await fetch(url);
  const text = await res.text();
  let body;
  try { body = JSON.parse(text); } catch { body = { error: `非 JSON 响应（${text.slice(0, 120)}）` }; }
  return { ok: res.ok, body };
}

/** 递归收集 workDir 下所有图片文件，跳过 .cache。 */
function collectImages(dir, out) {
  let entries;
  try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    const p = join(dir, e.name);
    if (e.isDirectory()) {
      if (e.name === '.cache' || e.name === 'node_modules') continue;
      collectImages(p, out);
    } else if (IMG_EXT.has(e.name.slice(e.name.lastIndexOf('.')).toLowerCase())) {
      (out.get(e.name) ?? out.set(e.name, []).get(e.name)).push(p);
    }
  }
}

async function main() {
  console.log(`从 ${BASE} 读取数据…`);
  const worksRes = await getJson(`${BASE}/api/works`);
  if (!worksRes.ok) throw new Error(`/api/works 失败：${JSON.stringify(worksRes.body).slice(0, 200)}`);
  const works = worksRes.body.works ?? [];

  const consoles = {};
  for (const w of works) {
    for (const ep of w.episodes ?? []) {
      const key = `${w.workId}|${ep.epId}`;
      const { ok, body } = await getJson(
        `${BASE}/api/segments?work=${encodeURIComponent(w.workId)}&episode=${encodeURIComponent(ep.epId)}`,
      );
      if (!ok || body.error) {
        consoles[key] = { error: body.error ?? `API 失败` };
        console.log(`  ${key} —— ${consoles[key].error}`);
        continue;
      }
      // 文件名 → 相对项目根的路径。同名文件优先取本集 media/images 下的。
      const episodeDir = resolve(ROOT, body.epDir);
      const found = new Map();
      collectImages(join(ROOT, 'storage/works', w.workId), found);
      const imgPaths = {};
      const names = new Set([
        ...body.segments.flatMap((s) => s.deps.map((d) => d.name)),
        ...body.assetCatalog.map((a) => a.name),
      ]);
      for (const name of names) {
        const hits = found.get(name) ?? [];
        if (hits.length === 0) continue; // 文件本来就不存在，页面按「文件不存在」渲染
        const inEp = hits.find((p) => p.startsWith(episodeDir + sep));
        imgPaths[name] = relative(ROOT, inEp ?? hits[0]);
      }
      // 绝对路径的视频改成相对项目根
      for (const s of body.segments) {
        if (s.videoPath) s.videoPath = relative(ROOT, s.videoPath);
      }
      consoles[key] = {
        epDir: body.epDir,
        segments: body.segments,
        assetCatalog: body.assetCatalog,
        assetSummary: body.assetSummary,
        imgPaths,
      };
      const nVideos = body.segments.filter((s) => s.hasVideo).length;
      console.log(`  ${key} —— ${body.segments.length} 段，${Object.keys(imgPaths).length} 张图，${nVideos} 段成片`);
    }
  }

  const snapshot = {
    exportedAt: new Date().toLocaleString('zh-CN'),
    works,
    consoles,
  };
  const template = readFileSync(join(ROOT, 'public/inde.html'), 'utf8');
  if (!template.includes('</head>')) throw new Error('public/inde.html 结构异常：找不到 </head>');
  const injected = template.replace(
    '</head>',
    `<script>window.__SNAPSHOT__ = ${JSON.stringify(snapshot).replace(/</g, '\\u003c')};</script></head>`,
  );
  const outPath = join(ROOT, 'inde.html');
  writeFileSync(outPath, injected);
  console.log(`已写出 ${outPath}（${(injected.length / 1e6).toFixed(1)} MB）`);
  console.log('注意：图片/视频按相对路径引用 storage/ 原文件，请保持 inde.html 与 storage/ 的相对位置不变。');
}

main().catch((err) => { console.error(err); process.exit(1); });
