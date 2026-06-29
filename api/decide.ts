import type { VercelRequest, VercelResponse } from '@vercel/node';
import { LLMClient } from '../src/server/llm/LLMClient';
import type { AntDecisionInput } from '../src/server/llm/PromptBuilder';

function envString(name: string, fallback: string): string {
  return process.env[name] || fallback;
}

function envInt(name: string, fallback: number): number {
  const value = process.env[name];
  return value ? parseInt(value, 10) : fallback;
}

export default async function handler(req: VercelRequest, res: VercelResponse): Promise<void> {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }

  const { systemPrompt, ants } = req.body || {};
  if (!Array.isArray(ants)) {
    res.status(400).json({ error: 'Missing or invalid ants array' });
    return;
  }

  const apiKey = process.env.LLM_API_KEY;
  if (!apiKey || apiKey === 'your-api-key-here') {
    res.status(503).json({ error: 'LLM_API_KEY not configured' });
    return;
  }

  const client = new LLMClient({
    apiKey,
    baseURL: envString('LLM_BASE_URL', 'https://api.openai.com/v1'),
    model: envString('LLM_MODEL', 'gpt-4o-mini'),
    timeoutMs: envInt('LLM_TIMEOUT_MS', 10000),
    maxRetries: envInt('LLM_MAX_RETRIES', 0),
  });

  if (typeof systemPrompt === 'string') {
    client.setSystemPrompt(systemPrompt);
  }

  try {
    const decisions = await client.decideBatch(ants as AntDecisionInput[]);
    res.status(200).json({ decisions });
  } catch (err) {
    console.error('[api/decide] LLM error:', err);
    res.status(502).json({
      error: err instanceof Error ? err.message : 'LLM request failed',
    });
  }
}
