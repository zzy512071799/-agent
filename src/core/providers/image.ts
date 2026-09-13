import { execFile } from 'node:child_process';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { deflateSync, crc32 } from 'node:zlib';
import type { ImageProvider } from './types';

const execFileAsync = promisify(execFile);

/**
 * 图片 provider：厂内 GPT-Image2（oneapi-comate.baidu-int.com）。
 *
 * 几个实测出来的行为决定了这里的实现，都和直觉相反：
 *
 * 1. 文生图 `/v1/images/generations` 完全忽略 size，固定输出 1254x1254 方图。
 * 2. 图生图 `/v1/images/edits` 的输出比例**跟着输入图走**。所以要拿到 9:16，
 *    办法是额外塞一张 9:16 的纯白画布当参考图，把比例拽过去 —— 比事后裁切好，
 *    画面内容不损失。
 * 3. `image[]` 可以重复传多张，多角色同框时每人一张参考图都能带上。
 * 4. Nano Banana（comate.baidu-int.com）那条路的 aspectRatio 现在已经失效，
 *    实测 9:16 / 16:9 / 3:4 全部返回 1254x1254，且需要额外的 login-name 凭证，
 *    所以不用它。
 */

const HOST = 'https://oneapi-comate.baidu-int.com';
const MODEL = 'gpt-image-2';

/** 参考图缩到这个最长边再上传。4K 原图约 8MB，token 贵且容易超时。 */
const REF_MAX_EDGE = 1536;

function token(): string {
  const t = process.env.ONEAPI_API_KEY;
  if (!t) throw new Error('ONEAPI_API_KEY 未配置，检查 .env');
  return t;
}

/** 手写最小 PNG 编码器，生成纯白画布。只为了控制输出比例，不值得引依赖。 */
function whiteCanvasPng(width: number, height: number): Buffer {
  const row = Buffer.concat([Buffer.from([0]), Buffer.alloc(width * 3, 0xff)]);
  const raw = Buffer.concat(Array.from({ length: height }, () => row));

  const chunk = (type: string, data: Buffer): Buffer => {
    const typeBuf = Buffer.from(type, 'ascii');
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])) >>> 0);
    return Buffer.concat([len, typeBuf, data, crc]);
  };

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // truecolor
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

const ASPECT_CANVAS: Record<string, [number, number]> = {
  '9:16': [720, 1280],
  '16:9': [1280, 720],
  '4:3': [1024, 768],
  '1:1': [1024, 1024],
};

/**
 * 参考图预处理：缩到 REF_MAX_EDGE 以内、转 JPEG 后缓存。
 *
 * 转 JPEG 不是可选项。gpt-image-2 出的图本来就是 1536x1024，`-Z 1536` 对它
 * 是空操作 —— 实测缩前缩后字节数完全相同（2550313 == 2550313），2.5MB 原样上传。
 * 一次分镜图要传场景图 + 最多 3 张角色图 + 白画布，接近 10MB，并发 10 时
 * 80-100MB 同时在飞，24 张全部 `fetch failed`。质量 85 的 JPEG 能压到 1/10。
 *
 * 用 macOS 自带的 sips，避免为了缩图引入 sharp/ffmpeg。非 macOS 环境会失败，
 * 到时候换实现即可 —— 缩图结果有缓存，不影响主流程语义。
 */
/**
 * 同一张参考图会被多个镜头同时用到，并发时会重复缩图并抢同一个输出文件。
 * 实测报 `sips: Cannot to rename temporary file ... Error 13` —— 两个 sips 进程
 * 同时往一个目标写。用 in-flight 表让同路径只做一次，后来者等前者的结果。
 */
const shrinking = new Map<string, Promise<string>>();

async function shrinkRef(path: string, cacheDir: string): Promise<string> {
  const out = join(cacheDir, `shrunk-${basename(path).replace(/\.[^.]+$/, '')}.jpg`);
  if (existsSync(out)) return out;

  const running = shrinking.get(out);
  if (running) return running;

  const task = (async () => {
    await mkdir(cacheDir, { recursive: true });
    // 先写唯一临时名再 rename：即便跨进程也不会撞同一个中间文件
    const tmp = `${out}.${process.pid}.tmp.jpg`;
    await execFileAsync('sips', [
      '-Z', String(REF_MAX_EDGE),
      '-s', 'format', 'jpeg',
      '-s', 'formatOptions', '85',
      path, '--out', tmp,
    ]);
    await rename(tmp, out);
    return out;
  })().finally(() => shrinking.delete(out));

  shrinking.set(out, task);
  return task;
}

export interface OneApiImageOptions {
  /** 图片落地根目录，通常是 storage/<projectId>。 */
  workDir: string;
}

export function createOneApiImageProvider(opts: OneApiImageOptions): ImageProvider {
  const workDir = resolve(opts.workDir);
  const imagesDir = join(workDir, 'images');
  const cacheDir = join(workDir, '.cache');

  return {
    async generate(req) {
      // 网关的限流是整点式的：并发 10 时一批里总有几个撞 "Upstream rate limit exceeded"。
      // 退避重试比降并发划算 —— 降并发是所有请求都变慢，重试只惩罚撞上的那几个。
      const waits = [8000, 20000, 45000];
      for (let attempt = 0; ; attempt++) {
        try {
          return await once(req);
        } catch (e) {
          const msg = (e as Error).message;
          if (!/rate limit|429|too many requests/i.test(msg) || attempt >= waits.length) throw e;
          await new Promise((r) => setTimeout(r, waits[attempt]));
        }
      }
    },
  };

  async function once({ prompt, negativePrompt, aspectRatio, refImagePaths, filename }: Parameters<ImageProvider['generate']>[0]) {
      await mkdir(imagesDir, { recursive: true });
      const outPath = join(imagesDir, filename);

      // 负面提示词接口没有独立字段，并进 prompt
      const fullPrompt = negativePrompt ? `${prompt}. Avoid: ${negativePrompt}` : prompt;

      let res: Response;
      if (!refImagePaths?.length) {
        // 文生图：忽略 size，固定方图。角色卡走这条，方图正合适
        res = await fetch(`${HOST}/v1/images/generations`, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${token()}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ model: MODEL, prompt: fullPrompt }),
        });
      } else {
        const form = new FormData();
        form.append('model', MODEL);

        const canvas = ASPECT_CANVAS[aspectRatio];
        // 画布是"框"，必须在 prompt 里点明用途，否则模型可能把白底当内容画进去
        form.append(
          'prompt',
          canvas
            ? `${fullPrompt}. Output must fill the ${aspectRatio} vertical frame given by the blank white canvas reference; the canvas defines the output shape only, do not draw it.`
            : fullPrompt,
        );

        for (const ref of refImagePaths) {
          const small = await shrinkRef(resolve(ref), cacheDir);
          const bytes = new Uint8Array(await readFile(small));
          form.append('image[]', new Blob([bytes], { type: 'image/jpeg' }), basename(small));
        }
        if (canvas) {
          const bytes = new Uint8Array(whiteCanvasPng(canvas[0], canvas[1]));
          form.append('image[]', new Blob([bytes], { type: 'image/png' }), 'frame.png');
        }

        res = await fetch(`${HOST}/v1/images/edits`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${token()}` },
          body: form,
        });
      }

      const body = (await res.json()) as {
        error?: { message: string };
        data?: Array<{ b64_json?: string; url?: string }>;
        size?: string;
      };
      if (body.error) throw new Error(`图片生成失败: ${body.error.message}`);

      const item = body.data?.[0];
      if (item?.b64_json) {
        await writeFile(outPath, Buffer.from(item.b64_json, 'base64'));
      } else if (item?.url) {
        const img = await fetch(item.url);
        await writeFile(outPath, Buffer.from(await img.arrayBuffer()));
      } else {
        throw new Error(`图片生成失败: 响应里没有图片数据 ${JSON.stringify(body).slice(0, 300)}`);
      }

      return { path: outPath, size: body.size };
  }
}

/**
 * 占位 provider。生成一张纯白图并把 prompt / 参考图路径写成同名 .txt，
 * 用于在不消耗图片额度的情况下验证流水线接线（参考图有没有传到每个镜头）。
 */
export function createMockImageProvider(opts: { workDir: string }): ImageProvider {
  const imagesDir = join(resolve(opts.workDir), 'images');

  return {
    async generate({ prompt, aspectRatio, refImagePaths, filename }) {
      await mkdir(imagesDir, { recursive: true });
      const path = join(imagesDir, filename);
      const [w, h] = ASPECT_CANVAS[aspectRatio] ?? [64, 64];
      await writeFile(path, whiteCanvasPng(w, h));
      await writeFile(
        `${path}.txt`,
        `prompt:\n${prompt}\n\nrefImagePaths:\n${(refImagePaths ?? []).join('\n') || '(none)'}\n`,
      );
      return { path, size: `${w}x${h}` };
    },
  };
}

