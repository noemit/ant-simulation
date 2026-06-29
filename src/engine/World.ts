import { ChemicalLayer } from './ChemicalLayer';
import { DiffusionSolver } from './DiffusionSolver';
import { createAnt, moveAnt, spendEnergy, applyToxinDamage } from './Ant';
import { buildAntPayload } from './payload';
import type {
  Ant,
  AntTarget,
  ChemicalType,
  Food,
  Hazard,
  Gap,
  WorldConfig,
} from './types';

export class World {
  readonly config: WorldConfig;
  ants: Ant[] = [];
  readonly foods: Food[] = [];
  readonly hazards: Hazard[] = [];
  readonly gaps: Gap[] = [];
  readonly layers: Record<ChemicalType, ChemicalLayer>;
  readonly diffusion: DiffusionSolver;

  nestX: number;
  nestY: number;
  tickCount = 0;

  constructor(config: WorldConfig) {
    this.config = config;

    this.layers = {
      // Trail: ground, low diffusion, very slow decay.
      raid_trail: new ChemicalLayer(config.gridWidth, config.gridHeight, {
        diffusionRate: 0.05,
        evaporationRate: 0.002,
      }),
      // Alarm: air, high diffusion, fast decay.
      mandibular_alarm: new ChemicalLayer(config.gridWidth, config.gridHeight, {
        diffusionRate: 0.25,
        evaporationRate: 0.08,
      }),
      // Food/nest trail: environmental, higher diffusion so the nest smell
      // spreads outward as a gradient, and no decay so it never fades.
      food_trail: new ChemicalLayer(config.gridWidth, config.gridHeight, {
        diffusionRate: 0.15,
        evaporationRate: 0.0,
      }),
      // Toxin: environmental, high diffusion, no decay (constant source).
      toxin_scent: new ChemicalLayer(config.gridWidth, config.gridHeight, {
        diffusionRate: 0.25,
        evaporationRate: 0.0,
      }),
      // Prey/food: environmental, medium diffusion, slow decay.
      prey_scent: new ChemicalLayer(config.gridWidth, config.gridHeight, {
        diffusionRate: 0.15,
        evaporationRate: 0.005,
      }),
    };

    // Nest on the left, food on the right.
    this.nestX = config.width * 0.2;
    this.nestY = config.height * 0.5;

    this.seedFoodTrail();
    this.seedFoodAndPreyScent();
    this.createHazards();
    this.createGaps();
    this.spawnAnts();

    this.diffusion = new DiffusionSolver();
  }

  private seedFoodTrail(): void {
    const foodTrail = this.layers.food_trail;
    // Seed a strong, broad nest scent so it forms a long-range gradient.
    for (let i = 0; i < 3000; i++) {
      const angle = Math.random() * Math.PI * 2;
      const radius = Math.random() * 180;
      const gx = this.toGridX(this.nestX + Math.cos(angle) * radius);
      const gy = this.toGridY(this.nestY + Math.sin(angle) * radius);
      foodTrail.deposit(gx, gy, 20.0 * Math.exp(-radius / 70));
    }
  }

  private seedFoodAndPreyScent(): void {
    const prey = this.layers.prey_scent;

    // Most prey lies beyond the gaps and hazards, forcing raiding behavior.
    // Place one food item close to the nest so the colony can quickly demonstrate
    // trail activation when an ant finds it and carries food back.
    for (let i = 0; i < this.config.foodCount; i++) {
      const angle = Math.random() * Math.PI * 2;
      const radius = Math.random() * 60;
      let fx: number;
      let fy: number;

      if (i === 0) {
        // Near-nest bait: far enough to encourage real raiding, close enough to find quickly.
        const baitAngle = (Math.random() - 0.5) * 1.2;
        const baitDist = 180 + Math.random() * 80;
        fx = this.nestX + Math.cos(baitAngle) * baitDist;
        fy = this.nestY + Math.sin(baitAngle) * baitDist;
      } else {
        fx = this.config.width * (0.62 + Math.random() * 0.12) + Math.cos(angle) * radius;
        fy = this.config.height * (0.25 + Math.random() * 0.5) + Math.sin(angle) * radius;
      }

      this.foods.push({ id: `food-${i}`, x: fx, y: fy, radius: 25, amount: 10 });
      const gx = this.toGridX(fx);
      const gy = this.toGridY(fy);
      prey.deposit(gx, gy, 40 * Math.exp(-radius / 35));
    }
  }

  private createHazards(): void {
    for (let i = 0; i < this.config.hazardCount; i++) {
      this.hazards.push({
        id: `hazard-${i}`,
        x: this.config.width * (0.42 + Math.random() * 0.1),
        y: this.config.height * (0.2 + Math.random() * 0.15 + (i % 3) * 0.22),
        radius: 20 + Math.random() * 14,
      });
    }
  }

  private createGaps(): void {
    for (let i = 0; i < this.config.gapCount; i++) {
      this.gaps.push({
        id: `gap-${i}`,
        x: this.config.width * (0.5 + i * 0.08),
        y: this.config.height * (0.25 + Math.random() * 0.4),
        width: 20,
        height: 60 + Math.random() * 60,
      });
    }
  }

  private spawnAnts(): void {
    for (let i = 0; i < this.config.antCount; i++) {
      const angle = Math.random() * Math.PI * 2;
      const radius = Math.random() * 90;
      this.ants.push(
        createAnt(
          this.nestX + Math.cos(angle) * radius,
          this.nestY + Math.sin(angle) * radius,
          Math.random() * Math.PI * 2,
          this.config.startingEnergy,
          this.config.antRadius
        )
      );
    }
  }

  toGridX(worldX: number): number {
    return (worldX / this.config.width) * this.config.gridWidth;
  }

  toGridY(worldY: number): number {
    return (worldY / this.config.height) * this.config.gridHeight;
  }

  sampleLayer(type: ChemicalType, worldX: number, worldY: number): number {
    return this.layers[type].sample(this.toGridX(worldX), this.toGridY(worldY));
  }

  gradientLayer(
    type: ChemicalType,
    worldX: number,
    worldY: number
  ): { x: number; y: number } {
    return this.layers[type].gradient(this.toGridX(worldX), this.toGridY(worldY));
  }

  isInsideGap(x: number, y: number): boolean {
    for (const gap of this.gaps) {
      if (
        x >= gap.x &&
        x <= gap.x + gap.width &&
        y >= gap.y &&
        y <= gap.y + gap.height
      ) {
        return true;
      }
    }
    return false;
  }

  // 'forward' is intentionally not allowed as an LLM direction. Ants must curve
  // slightly, so forward-left/right are widened to cover straight ahead.
  private static readonly DIRECTION_RANGES: Record<string, [number, number]> = {
    'forward left': [(-5 * Math.PI) / 180, (35 * Math.PI) / 180],
    left: [(35 * Math.PI) / 180, (65 * Math.PI) / 180],
    'hard left': [(65 * Math.PI) / 180, (90 * Math.PI) / 180],
    'forward right': [(-35 * Math.PI) / 180, (5 * Math.PI) / 180],
    right: [(-65 * Math.PI) / 180, (-35 * Math.PI) / 180],
    'hard right': [(-90 * Math.PI) / 180, (-65 * Math.PI) / 180],
  };

  /**
   * Convert the ant's current direction target into a target heading (slope).
   * Each direction maps to a small angular range so ants with the same target
   * don't move in identical arcs. The offset is added to the heading the ant
   * had when this direction was first issued, not its current heading, so a
   * repeated "left" command does not keep accumulating into a circle.
   */
  private updateTargetHeading(ant: Ant): void {
    const dir = ant.targetDirection ?? 'forward';
    const [minOffset, maxOffset] = World.DIRECTION_RANGES[dir] ?? [0, 0];
    const offset = minOffset + Math.random() * (maxOffset - minOffset);
    const base = ant.commandBaseHeading ?? ant.heading;
    let targetHeading = base + offset;
    while (targetHeading > Math.PI) targetHeading -= Math.PI * 2;
    while (targetHeading <= -Math.PI) targetHeading += Math.PI * 2;
    ant.targetHeading = targetHeading;
  }

  /**
   * Turn the ant gradually toward its current target heading.
   */
  private turnTowardTargetHeading(ant: Ant): void {
    const target = ant.targetHeading ?? ant.heading;
    let delta = target - ant.heading;
    while (delta > Math.PI) delta -= Math.PI * 2;
    while (delta <= -Math.PI) delta += Math.PI * 2;

    const maxTurn = Math.PI / 12;
    const clampedDelta = Math.max(-maxTurn, Math.min(maxTurn, delta));
    let newHeading = ant.heading + clampedDelta;
    while (newHeading > Math.PI) newHeading -= Math.PI * 2;
    while (newHeading <= -Math.PI) newHeading += Math.PI * 2;
    ant.heading = newHeading;
  }

  private tryBite(ant: Ant): void {
    for (const food of this.foods) {
      const dx = food.x - ant.x;
      const dy = food.y - ant.y;
      const dist = Math.hypot(dx, dy);
      if (dist < food.radius + ant.radius) {
        ant.carryingFood = true;
        food.amount = Math.max(0, food.amount - 1);
        ant.energy = Math.min(100, ant.energy + 15);
        ant.hunger = Math.max(0, ant.hunger - 20);
        ant.lastAction = 'picked_up_food';
        return;
      }
    }
    ant.lastAction = 'moving';
  }

  findNearestFood(ant: Ant): { food: import('./types').Food; dist: number } | null {
    let nearest: import('./types').Food | null = null;
    let nearestDist = Infinity;
    for (const food of this.foods) {
      const dist = Math.hypot(food.x - ant.x, food.y - ant.y);
      if (dist < nearestDist) {
        nearestDist = dist;
        nearest = food;
      }
    }
    return nearest ? { food: nearest, dist: nearestDist } : null;
  }

  private resolveCollisions(): void {
    const ants = this.ants;
    for (let i = 0; i < ants.length; i++) {
      const a = ants[i];
      for (let j = i + 1; j < ants.length; j++) {
        const b = ants[j];
        const dx = b.x - a.x;
        const dy = b.y - a.y;
        const dist = Math.hypot(dx, dy);
        const minDist = a.radius + b.radius;
        if (dist < minDist && dist > 0) {
          const overlap = (minDist - dist) / 2;
          const nx = dx / dist;
          const ny = dy / dist;
          a.x -= nx * overlap;
          a.y -= ny * overlap;
          b.x += nx * overlap;
          b.y += ny * overlap;
        }
      }
    }
  }

  private applyHazards(dt: number): void {
    for (const ant of this.ants) {
      let inHazard = false;
      for (const hazard of this.hazards) {
        const dx = ant.x - hazard.x;
        const dy = ant.y - hazard.y;
        if (Math.hypot(dx, dy) < hazard.radius) {
          inHazard = true;
          applyToxinDamage(ant, dt);
          this.layers.mandibular_alarm.deposit(
            this.toGridX(ant.x),
            this.toGridY(ant.y),
            0.5
          );
        }
      }
      ant.inToxicArea = inHazard;
    }
  }

  tick(dt: number, getTarget: (ant: Ant, world: World) => AntTarget | undefined): void {
    this.tickCount++;

    // Every ant gets a target from the LLM/fallback controller.
    for (const ant of this.ants) {
      const target = getTarget(ant, this);
      if (target) {
        const newDirection = target.direction;
        if (ant.targetDirection !== newDirection) {
          // Direction changed: lock the base heading and compute a new target slope.
          ant.commandBaseHeading = ant.heading;
          ant.targetDirection = newDirection;
          this.updateTargetHeading(ant);
        }
        if (target.speed !== undefined) {
          ant.targetSpeed = Math.max(
            this.config.minSpeed,
            Math.min(this.config.maxSpeed, target.speed)
          );
        }
      }
      ant.lastSenses = buildAntPayload(ant, this);
    }

    // Move ants.
    for (const ant of this.ants) {
      this.turnTowardTargetHeading(ant);
      ant.speed = ant.targetSpeed ?? this.config.maxSpeed * 0.7;
      moveAnt(ant, dt, { width: this.config.width, height: this.config.height });
      this.keepOutOfGaps(ant);
      spendEnergy(ant, this.config.energyCostFactor, dt);

      // Automatic food pickup when touching food.
      if (!ant.carryingFood) {
        this.tryBite(ant);
      }
    }

    // Resolve collisions.
    this.resolveCollisions();

    // Apply hazard damage and mark ants in toxic areas.
    this.applyHazards(dt);

    // Instant death at zero energy.
    this.ants = this.ants.filter((ant) => ant.energy > 0);

    // Food drop and respawn.
    this.handleFoodAtNest();
    this.respawnFoodIfDepleted();

    // Deposit ant-controlled pheromones.
    for (const ant of this.ants) {
      const gx = this.toGridX(ant.x);
      const gy = this.toGridY(ant.y);

      if (ant.carryingFood) {
        // Returning carriers drop a strong recruitment trail and a faint food/nest trail.
        this.layers.raid_trail.deposit(gx, gy, 15.0);
        this.layers.food_trail.deposit(gx, gy, 1.0);
      } else if (ant.speed > 0.1) {
        // Explorers drop a weak trail so the swarm does not get lost.
        this.layers.raid_trail.deposit(gx, gy, 4.0);
      }
    }

    // Hazards constantly emit toxin scent.
    for (const hazard of this.hazards) {
      this.layers.toxin_scent.deposit(
        this.toGridX(hazard.x),
        this.toGridY(hazard.y),
        3.0
      );
    }

    // Diffuse and evaporate.
    this.diffusion.step(Object.values(this.layers));
  }

  private keepOutOfGaps(ant: Ant): void {
    if (!this.isInsideGap(ant.x, ant.y)) {
      return;
    }

    // Push the ant to the nearest gap edge.
    let bestX = ant.x;
    let bestY = ant.y;
    let bestDist = Infinity;

    for (const gap of this.gaps) {
      const candidates = [
        { x: gap.x - ant.radius, y: ant.y },
        { x: gap.x + gap.width + ant.radius, y: ant.y },
        { x: ant.x, y: gap.y - ant.radius },
        { x: ant.x, y: gap.y + gap.height + ant.radius },
      ];
      for (const c of candidates) {
        const d = Math.hypot(c.x - ant.x, c.y - ant.y);
        if (d < bestDist) {
          bestDist = d;
          bestX = c.x;
          bestY = c.y;
        }
      }
    }

    ant.x = bestX;
    ant.y = bestY;
  }

  private handleFoodAtNest(): void {
    const nestRadius = 35;
    for (const ant of this.ants) {
      if (
        ant.carryingFood &&
        Math.hypot(ant.x - this.nestX, ant.y - this.nestY) < nestRadius
      ) {
        ant.carryingFood = false;
        ant.energy = Math.min(100, ant.energy + 25);
        ant.hunger = Math.max(0, ant.hunger - 30);
        ant.lastAction = 'dropped_food';
      }
    }
  }

  private respawnFoodIfDepleted(): void {
    const remaining = this.foods.reduce((sum, f) => sum + f.amount, 0);
    if (remaining > 0) return;

    // All food is gone: spawn a new patch elsewhere to keep the swarm active.
    this.foods.length = 0;
    this.layers.prey_scent.clear();
    for (let i = 0; i < this.config.foodCount; i++) {
      const fx = this.config.width * (0.55 + Math.random() * 0.25);
      const fy = this.config.height * (0.2 + Math.random() * 0.6);
      this.foods.push({ id: `food-${this.tickCount}-${i}`, x: fx, y: fy, radius: 8, amount: 10 });
      this.layers.prey_scent.deposit(this.toGridX(fx), this.toGridY(fy), 15);
    }
  }
}
