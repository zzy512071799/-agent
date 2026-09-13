import { z } from 'zod';
import type { LlmProvider } from './types';

const baseUrl = () => process.env.ONEAPI_BASE_URL ?? 'http://oneapi.ai-chat.host:8602';
const apiKey = () => process.env.ONEAPI_API_KEY ?? '';
export const DEFAULT_MODEL = 'Claude Sonnet 5';
export const FAST_MODEL = 'DeepSeek-V4-Flash';

async function chat(messages: Array<{ role: string; content: string }>, model: string) {
  if (!apiKey()) throw new Error('ONEAPI_API_KEY 未配置，检查 .env');
  const res = await fetch(`${baseUrl()}/v1/chat/completions`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey()}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model, messages, temperature: 0.7 }),
  });
  const raw = await res.text();
  if (!res.ok) throw new Error(`One API ${res.status}: ${raw.slice(0, 500)}`);
  const parsed = JSON.parse(raw) as { choices?: Array<{ message?: { content?: string } }> };
  const content = parsed.choices?.[0]?.message?.content;
  if (typeof content !== 'string') throw new Error(`One API 返回格式异常: ${raw.slice(0, 500)}`);
  return content;
}

function stripFence(text: string) {
  const match = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  return (match ? match[1] : text).trim();
}

export const oneApiLlm: LlmProvider = {
  complete(prompt, opts) {
    return chat([
      ...(opts?.system ? [{ role: 'system', content: opts.system }] : []),
      { role: 'user', content: prompt },
    ], opts?.model ?? DEFAULT_MODEL);
  },
  async completeJson(prompt, schema, opts) {
    let lastError = '';
    for (let i = 0; i <= (opts?.maxRetries ?? 2); i++) {
      const text = await chat([
        { role: 'system', content: `${opts?.system ?? ''}\n只输出一个 JSON 对象，不要解释文字。` },
        { role: 'user', content: `${prompt}${lastError ? `\n上次输出错误：${lastError}` : ''}` },
      ], opts?.model ?? DEFAULT_MODEL);
      try {
        const result = schema.safeParse(JSON.parse(stripFence(text)));
        if (result.success) return result.data;
        lastError = JSON.stringify(result.error.issues.slice(0, 5));
      } catch (error) { lastError = `JSON 解析失败: ${(error as Error).message}`; }
    }
    throw new Error(`结构化输出重试后仍失败: ${lastError}`);
  },
};
