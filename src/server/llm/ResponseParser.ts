import { z } from 'zod';
import type { AntTarget } from '../../engine/types';

const VALID_DIRECTIONS = [
  'forward left',
  'left',
  'hard left',
  'forward right',
  'right',
  'hard right',
] as const;

const DecisionSchema = z.object({
  ant_id: z.string(),
  target: z.enum(VALID_DIRECTIONS),
});

const SubmitDecisionsSchema = z.object({
  decisions: z.array(DecisionSchema),
});

export interface ParsedDecision {
  antId: string;
  target: AntTarget;
}

export function parseDecisions(raw: string): ParsedDecision[] {
  const parsed = JSON.parse(raw);
  const validated = SubmitDecisionsSchema.parse(parsed);

  const results: ParsedDecision[] = [];
  for (const d of validated.decisions) {
    if (!d.target) {
      console.warn(`LLM decision for ${d.ant_id} missing target; skipping ant`);
      continue;
    }

    results.push({
      antId: d.ant_id,
      target: {
        direction: d.target,
      },
    });
  }

  return results;
}
