import { z } from 'zod';

export interface LlmProvider {
  complete(prompt: string, opts?: { system?: string; model?: string }): Promise<string>;
  completeJson<T extends z.ZodTypeAny>(prompt: string, schema: T, opts?: { system?: string; model?: string; maxRetries?: number }): Promise<z.infer<T>>;
}

export interface ImageProvider {
  generate(params: { prompt: string; negativePrompt?: string; aspectRatio: string; refImagePaths?: string[]; filename: string }): Promise<{ path: string; size?: string }>;
}

export interface TtsProvider {
  synthesize(params: { text: string; voiceId: string | null; emotion?: string }): Promise<{ path: string; durationSec: number }>;
}
