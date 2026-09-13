export interface H3Reference {
  path: string;
  role: 'first_frame' | 'last_frame' | 'reference_image';
}

export function createH3Provider(opts: { workDir: string }) {
  return {
    async generate(params: {
      prompt: string;
      references?: H3Reference[];
      durationSec: number;
      resolution?: '768p' | '1440p' | '2K';
      ratio?: string;
      outPath: string;
      onTaskCreated?: (taskId: string) => void;
    }) {
      throw new Error(`H3 provider 未恢复，无法生成 ${params.outPath}（工作目录：${opts.workDir}）`);
    },
  };
}
