import type { Ant as AntState } from './types';

let nextId = 0;

export function createAnt(
  x: number,
  y: number,
  heading: number,
  energy: number,
  radius: number
): AntState {
  return {
    id: `ant-${nextId++}`,
    x,
    y,
    heading,
    speed: 0,
    energy,
    hunger: 0,
    carryingFood: false,
    lastAction: 'spawned',
    radius,
    inToxicArea: false,
    targetDirection: Math.random() < 0.5 ? 'forward left' : 'forward right',
    targetSpeed: 3,
    targetHeading: heading,
  };
}

export function moveAnt(
  ant: AntState,
  dt: number,
  bounds: { width: number; height: number }
): void {
  // Scale raw speed into world units. Lower = slower, more deliberate movement.
  const MOVE_SCALE = 2.5;
  const startHeading = ant.heading;
  const dx = Math.cos(startHeading) * ant.speed * MOVE_SCALE * dt;
  const dy = Math.sin(startHeading) * ant.speed * MOVE_SCALE * dt;

  let nextX = ant.x + dx;
  let nextY = ant.y + dy;

  const overshootLeft = ant.radius - nextX;
  const overshootRight = nextX - (bounds.width - ant.radius);
  const overshootTop = ant.radius - nextY;
  const overshootBottom = nextY - (bounds.height - ant.radius);
  const overshootX = Math.max(overshootLeft, overshootRight, 0);
  const overshootY = Math.max(overshootTop, overshootBottom, 0);

  let newHeading = startHeading;
  let bounced = false;

  if (overshootX > 0 || overshootY > 0) {
    // Only turn for the wall that is hit most (or first). Handling both axes
    // in one tick can add up to a U-turn in a corner.
    if (overshootX >= overshootY) {
      if (overshootLeft > 0) nextX = ant.radius;
      else if (overshootRight > 0) nextX = bounds.width - ant.radius;
      newHeading = closestForwardHeading(startHeading, Math.PI - startHeading);
      nextY = Math.max(ant.radius, Math.min(bounds.height - ant.radius, nextY));
    } else {
      if (overshootTop > 0) nextY = ant.radius;
      else if (overshootBottom > 0) nextY = bounds.height - ant.radius;
      newHeading = closestForwardHeading(startHeading, -startHeading);
      nextX = Math.max(ant.radius, Math.min(bounds.width - ant.radius, nextX));
    }
    bounced = true;
  }

  ant.x = nextX;
  ant.y = nextY;
  ant.heading = normalizeHeading(newHeading);

  // After a bounce, lock the ant onto its new forward heading so it doesn't
  // immediately try to steer back into the wall on the next tick.
  if (bounced) {
    ant.commandBaseHeading = ant.heading;
    ant.targetHeading = ant.heading;
  }
}

/**
 * Return the heading closest to `current` that is within the ant's forward
 * arc (±90°). If `preferred` is behind the ant, this picks the nearest
 * left or right direction instead of doing a U-turn.
 */
function closestForwardHeading(current: number, preferred: number): number {
  let delta = preferred - current;
  while (delta > Math.PI) delta -= Math.PI * 2;
  while (delta <= -Math.PI) delta += Math.PI * 2;

  if (delta > Math.PI / 2) delta = Math.PI / 2;
  if (delta < -Math.PI / 2) delta = -Math.PI / 2;

  return normalizeHeading(current + delta);
}

export function spendEnergy(ant: AntState, costFactor: number, dt: number): void {
  // Energy cost scales with the square of speed, so sprinting is expensive.
  const cost = ant.speed * ant.speed * costFactor * dt;
  ant.energy = Math.max(0, ant.energy - cost);

  // Hunger rises when energy is low.
  if (ant.energy < 30) {
    ant.hunger = Math.min(100, ant.hunger + 0.3 * dt);
  } else {
    ant.hunger = Math.max(0, ant.hunger - 0.05 * dt);
  }
}

export function applyToxinDamage(ant: AntState, dt: number): void {
  ant.energy = Math.max(0, ant.energy - 8 * dt);
  ant.hunger = Math.min(100, ant.hunger + 2 * dt);
}

function normalizeHeading(h: number): number {
  while (h > Math.PI) h -= Math.PI * 2;
  while (h <= -Math.PI) h += Math.PI * 2;
  return h;
}
