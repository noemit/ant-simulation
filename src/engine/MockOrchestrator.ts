import type { Ant, AntTarget } from './types';
import type { World } from './World';
import { buildAntPayload } from './payload';

function pickForwardSide(): string {
  return Math.random() < 0.5 ? 'forward left' : 'forward right';
}

// Map a scent direction to a movement direction that brings the scent forward.
// 'forward' scents are mapped to a slight curve so the ant keeps moving.
const TOWARD_DIR: Record<string, string> = {
  forward: 'forward left',
  'forward left': 'forward left',
  left: 'left',
  'behind left': 'hard left',
  behind: 'hard left',
  'behind right': 'hard right',
  right: 'right',
  'forward right': 'forward right',
  'all around': 'forward left',
};

// Map a scent direction to a movement direction that moves away from it.
const AVOID_DIR: Record<string, string> = {
  forward: 'forward right',
  'forward left': 'forward right',
  left: 'right',
  'behind left': 'forward right',
  behind: 'forward',
  'behind right': 'forward left',
  right: 'left',
  'forward right': 'forward left',
  'all around': 'forward right',
};

export class MockOrchestrator {
  decide(ant: Ant, world: World): AntTarget {
    const payload = buildAntPayload(ant, world);
    const smells = payload.senses.smell_points;

    // 1. Toxic area: move away from toxin scent.
    const toxin = smells.toxin_scent;
    if (toxin && toxin.strength > 0.1) {
      const dir = AVOID_DIR[toxin.coming_from] ?? pickForwardSide();
      return { direction: dir === 'forward' ? pickForwardSide() : dir };
    }

    // 2. Carrying food: follow food trail home.
    if (ant.carryingFood) {
      const home = smells.food_trail;
      if (home && home.strength > 0.05) {
        const dir = TOWARD_DIR[home.coming_from] ?? pickForwardSide();
        return { direction: dir === 'forward' ? pickForwardSide() : dir };
      }
      return { direction: pickForwardSide() };
    }

    // 3. Find food: follow a strong raid trail.
    const raid = smells.raid_trail;
    if (raid && raid.strength > 0.15) {
      const dir = TOWARD_DIR[raid.coming_from] ?? pickForwardSide();
      return { direction: dir === 'forward' ? pickForwardSide() : dir };
    }

    // 4. Wander forward with a slight curve.
    return { direction: pickForwardSide() };
  }
}
