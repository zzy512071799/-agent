export interface Wan3ImageRef {
  index: number;
  token: string;
  name: string;
  path: string;
  role: 'first_frame' | 'last_frame' | 'reference_image' | 'visual_reference' | 'prop';
  exists: boolean;
  previewUrl?: string;
  uploadable: boolean;
  issue?: string;
}

export interface Wan3ReferencePlan {
  refs: string[];
  prompt: string;
  unresolved: string[];
}

const basename = (path: string) => path.split('/').pop() ?? path;

function referenceNeedles(path: string): string[] {
  const stem = basename(path).replace(/\.(png|jpe?g|webp)$/i, '');
  const parts = stem.split(/[-_]/).filter(Boolean);
  const suffix = stem.length > 2 ? stem.slice(-2) : '';
  return [...new Set([stem, ...parts, suffix])]
    .filter(Boolean)
    .sort((a, b) => b.length - a.length);
}

export function buildWan3ReferencePlan(
  prompt: string,
  refs: string[],
  continuityPath: string | null = null,
): Wan3ReferencePlan {
  const finalRefs = [...refs];
  const continuityOffset = continuityPath && finalRefs[0] === continuityPath && !prompt.includes('前一镜真实尾帧') ? 1 : 0;
  let output = prompt.replace(/@图片(\d+)(?:（[^）]*）)?/g, (_, rawIndex) => {
    const sourceIndex = Number(rawIndex);
    const finalIndex = sourceIndex + continuityOffset;
    const ref = finalRefs[finalIndex - 1];
    return ref ? `@图片${finalIndex}（${basename(ref)}）` : `@图片${finalIndex}`;
  });

  const unresolved: string[] = [];
  finalRefs.forEach((ref, index) => {
    const token = `@图片${index + 1}`;
    if (index === 0 && continuityPath === ref) {
      if (!output.includes(token)) {
        output = `连续性参考：${token}（前一镜真实尾帧）锁定本镜开场构图、人物站位和动作承接状态。\n${output}`;
      }
      return;
    }
    if (output.includes(token)) return;

    const lines = output.split('\n');
    const anchorLine = lines.findIndex((line) => {
      if (/^(生成单镜头|首帧锁定|首帧\/尾帧锁定|参考图锁定|结束状态|运镜|声音描述)/.test(line.trim())) return false;
      return referenceNeedles(ref).some((candidate) => line.includes(candidate));
    });
    const needle = anchorLine >= 0
      ? referenceNeedles(ref).find((candidate) => lines[anchorLine].includes(candidate))
      : undefined;
    if (needle && anchorLine >= 0) {
      lines[anchorLine] = lines[anchorLine].replace(needle, `${token}（${basename(ref)}）${needle}`);
      output = lines.join('\n');
    } else {
      unresolved.push(`${token}（${basename(ref)}）`);
    }
  });

  if (unresolved.length > 0) {
    output += `\n未定位参考约束：${unresolved.join('、')}必须保持其身份、结构和空间作用；图片顺序与上传顺序一致。`;
  }

  return { refs: finalRefs, prompt: output, unresolved };
}

export function extractWan3ImageTokens(prompt: string): number[] {
  return [...prompt.matchAll(/@图片(\d+)/g)].map((match) => Number(match[1]));
}

export function validateWan3ImageTokens(prompt: string, refs: Wan3ImageRef[]): string[] {
  const tokens = extractWan3ImageTokens(prompt);
  const errors: string[] = [];
  const expected = refs.filter((ref) => ref.uploadable).map((ref) => ref.index);
  for (const index of tokens) {
    if (!expected.includes(index)) errors.push(`@图片${index} 没有对应的可上传媒体`);
  }

  return errors;
}
