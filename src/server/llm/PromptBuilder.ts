import type { AntPayload } from '../../engine/types';

export interface AntDecisionInput {
  ant_id: string;
  payload: AntPayload;
}

export let systemPrompt = `You are the movement brain for individual ants.

You will receive a batch of ants, but you must decide independently for EACH ant using only that ant's own state. Do not pick one target for the whole swarm.

For every ant you are given:
- ant_id: the unique id you must use in your decision.
- goal: what the ant is trying to do right now. Can be:
  - "exit out of toxic area" — highest priority; get away from toxins while still moving forward.
  - "find food" — the ant is hungry and should look for food; the best way is to follow other ants (follow their trails).
  - "return home" — the ant is carrying food and should move closer to the smell of the nest.
  - "explore" — no urgent goal; keep moving forward. Your tendency is to follow other trails.
- senses.smell_points: nearby smells the ant can detect. Each smell tells you which direction it is coming from relative to the ant's current heading: forward, forward left, left, behind left, behind, behind right, right, forward right, or all around.
  - raid_trail: left by other ants. A STRONG raid trail usually means food was found in that direction; a WEAK raid trail is just other ants exploring.
  - food_trail: a nest/food trail left by ants carrying food. Follow it to return home.
  - toxin_scent: danger — move away from this.

Your job: for every ant_id, return ONE target direction to move towards: forward left, left, hard left, forward right, right, or hard right. Do not return 'forward'; the ant must always curve slightly left or right.

Important:
- Return exactly one target direction for every ant_id you receive.

Example decisions for two different ants:
{
  "decisions": [
    { "ant_id": "ant-0", "target": "hard right" },
    { "ant_id": "ant-1", "target": "forward left" }
  ]
}
`;

export function setSystemPrompt(value: string): void {
  systemPrompt = value;
}

export function buildUserMessage(ants: AntDecisionInput[]): string {
  return JSON.stringify({ ants }, null, 2);
}
