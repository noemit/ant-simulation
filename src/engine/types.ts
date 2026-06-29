export type ChemicalType =
  | 'raid_trail'
  | 'mandibular_alarm'
  | 'food_trail'
  | 'toxin_scent'
  | 'prey_scent';

export const ALL_CHEMICALS: ChemicalType[] = [
  'raid_trail',
  'mandibular_alarm',
  'food_trail',
  'toxin_scent',
  'prey_scent',
];

/** Chemicals exposed to the LLM in each ant's smell_points. */
export const LLM_CHEMICALS: ('raid_trail' | 'food_trail' | 'toxin_scent')[] = [
  'raid_trail',
  'food_trail',
  'toxin_scent',
];

export interface Vector2 {
  x: number;
  y: number;
}

export interface AntTarget {
  direction: string;
  speed?: number;
}

export interface Ant {
  id: string;
  x: number;
  y: number;
  heading: number;
  speed: number;
  energy: number;
  hunger: number;
  carryingFood: boolean;
  lastAction: string;
  radius: number;
  /** True when the ant is currently inside a hazard/toxic area. */
  inToxicArea: boolean;
  /** Direction target chosen by the LLM or fallback controller. */
  targetDirection?: string;
  targetSpeed?: number;
  /** Heading at the moment the current direction command was issued. The
   *  target heading is computed relative to this so repeated 'left' commands
   *  don't keep accumulating into a circle. */
  commandBaseHeading?: number;
  /** Heading derived from the current target. The ant steers toward this and then
   *  continues on this slope until a new target arrives. */
  targetHeading?: number;
  /** Sensory payload this ant perceived on the most recent tick. */
  lastSenses?: AntPayload;
}

export interface Food {
  id: string;
  x: number;
  y: number;
  radius: number;
  amount: number;
}

export interface Hazard {
  id: string;
  x: number;
  y: number;
  radius: number;
}

export interface Gap {
  id: string;
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface WorldConfig {
  width: number;
  height: number;
  gridWidth: number;
  gridHeight: number;
  antCount: number;
  diffusionRate: number;
  evaporationRate: number;
  energyCostFactor: number;
  maxSpeed: number;
  minSpeed: number;
  startingEnergy: number;
  antRadius: number;
  foodCount: number;
  hazardCount: number;
  gapCount: number;
}

export interface SimulationState {
  config: WorldConfig;
  ants: Ant[];
  foods: Food[];
  hazards: Hazard[];
  gaps: Gap[];
  nestX: number;
  nestY: number;
  tick: number;
}

export interface SmellInfo {
  /** Relative direction the scent is coming from: forward, left, right, or behind. */
  coming_from: string;
  /** Normalized strength of the scent at the ant's current tile, 0.0–1.0. */
  strength: number;
}

export interface AntPayload {
  internal_state: {
    goal: string;
  };
  senses: {
    /** Per-chemical smell directions relative to the ant's heading. */
    smell_points: Partial<Record<'raid_trail' | 'food_trail' | 'toxin_scent', SmellInfo>>;
  };
}
