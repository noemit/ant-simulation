import { LLM_CHEMICALS, type Ant, type AntPayload, type ChemicalType, type SmellInfo } from './types';
import type { World } from './World';

/** Cap used to normalize local scent strength into 0.0–1.0. */
const SCENT_STRENGTH_CAP = 10;

/** Hunger threshold above which the ant should prioritize finding food. */
const HUNGRY_THRESHOLD = 30;

/** If the scent gradient is weaker than this, the smell feels like it's everywhere. */
const ALL_AROUND_GRADIENT_THRESHOLD = 0.03;

let activeChemicals: readonly ('raid_trail' | 'food_trail' | 'toxin_scent')[] = [...LLM_CHEMICALS];

export function setActiveChemicals(chemicals: string[]): void {
  activeChemicals = chemicals.filter((c): c is 'raid_trail' | 'food_trail' | 'toxin_scent' =>
    LLM_CHEMICALS.includes(c as 'raid_trail' | 'food_trail' | 'toxin_scent')
  );
}

export function getActiveChemicals(): readonly ('raid_trail' | 'food_trail' | 'toxin_scent')[] {
  return activeChemicals;
}

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}

function determineGoal(ant: Ant): string {
  if (ant.inToxicArea) return 'exit out of toxic area';
  if (ant.carryingFood) return 'return home';
  if (ant.hunger > HUNGRY_THRESHOLD) return 'find food';
  return 'explore';
}

function relativeDirection(antHeading: number, sourceAngle: number): string {
  let delta = sourceAngle - antHeading;
  while (delta > Math.PI) delta -= Math.PI * 2;
  while (delta <= -Math.PI) delta += Math.PI * 2;

  const abs = Math.abs(delta);
  if (abs <= Math.PI / 8) return 'forward';
  if (abs >= (7 * Math.PI) / 8) return 'behind';

  if (delta > 0) {
    if (abs <= (3 * Math.PI) / 8) return 'forward left';
    if (abs <= (5 * Math.PI) / 8) return 'left';
    return 'behind left';
  } else {
    if (abs <= (3 * Math.PI) / 8) return 'forward right';
    if (abs <= (5 * Math.PI) / 8) return 'right';
    return 'behind right';
  }
}

export function buildAntPayload(ant: Ant, world: World): AntPayload {
  const smellPoints: Partial<Record<ChemicalType, SmellInfo>> = {};
  for (const chemical of activeChemicals) {
    const grad = world.gradientLayer(chemical, ant.x, ant.y);
    const magnitude = Math.hypot(grad.x, grad.y);
    if (magnitude > 0.001) {
      const angle = Math.atan2(grad.y, grad.x);
      const localStrength = world.sampleLayer(chemical, ant.x, ant.y);
      let comingFrom: string;
      if (localStrength > 0.05 && magnitude < ALL_AROUND_GRADIENT_THRESHOLD) {
        comingFrom = 'all around';
      } else {
        comingFrom = relativeDirection(ant.heading, angle);
      }
      smellPoints[chemical] = {
        coming_from: comingFrom,
        strength: round1(Math.min(1, Math.max(0, localStrength / SCENT_STRENGTH_CAP))),
      };
    }
  }

  return {
    internal_state: {
      goal: determineGoal(ant),
    },
    senses: {
      smell_points: smellPoints,
    },
  };
}
