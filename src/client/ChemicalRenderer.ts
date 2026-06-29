import type { World } from '../engine/World';
import type { ChemicalType } from '../engine/types';

const COLORS: Record<ChemicalType, [number, number, number]> = {
  raid_trail: [200, 60, 20],
  mandibular_alarm: [255, 20, 60],
  food_trail: [20, 80, 220],
  toxin_scent: [120, 220, 40],
  prey_scent: [240, 220, 40],
};

/**
 * Renders the world's chemical layers to a canvas on the CPU.
 *
 * This replaces the server-generated PNG snapshots used by the original
 * WebSocket server. It is always available (no WebGPU required) and shows
 * every layer: raid trails, food/nest trails, toxins, prey scent and alarm.
 */
export class ChemicalRenderer {
  readonly canvas: HTMLCanvasElement;
  private readonly ctx: CanvasRenderingContext2D;
  private imageData: ImageData;

  constructor(world: World) {
    this.canvas = document.createElement('canvas');
    this.canvas.width = world.config.gridWidth;
    this.canvas.height = world.config.gridHeight;
    this.ctx = this.canvas.getContext('2d', { alpha: false })!;
    this.imageData = this.ctx.createImageData(this.canvas.width, this.canvas.height);
  }

  resize(world: World): void {
    const w = world.config.gridWidth;
    const h = world.config.gridHeight;
    if (this.canvas.width !== w || this.canvas.height !== h) {
      this.canvas.width = w;
      this.canvas.height = h;
      this.imageData = this.ctx.createImageData(w, h);
    }
  }

  render(world: World): void {
    this.resize(world);

    const w = world.config.gridWidth;
    const h = world.config.gridHeight;
    const data = this.imageData.data;

    const raid = world.layers.raid_trail.current;
    const alarm = world.layers.mandibular_alarm.current;
    const food = world.layers.food_trail.current;
    const toxin = world.layers.toxin_scent.current;
    const prey = world.layers.prey_scent.current;

    const [raidR, raidG, raidB] = COLORS.raid_trail;
    const [alarmR, alarmG, alarmB] = COLORS.mandibular_alarm;
    const [foodR, foodG, foodB] = COLORS.food_trail;
    const [toxinR, toxinG, toxinB] = COLORS.toxin_scent;
    const [preyR, preyG, preyB] = COLORS.prey_scent;

    for (let y = 0; y < h; y++) {
      const row = y * w;
      for (let x = 0; x < w; x++) {
        const i = row + x;
        const ri = Math.min(1, raid[i]);
        const ai = Math.min(1, alarm[i]);
        const fi = Math.min(1, food[i]);
        const ti = Math.min(1, toxin[i]);
        const pi = Math.min(1, prey[i]);

        let r = ri * raidR + ai * alarmR + fi * foodR + ti * toxinR + pi * preyR;
        let g = ri * raidG + ai * alarmG + fi * foodG + ti * toxinG + pi * preyG;
        let b = ri * raidB + ai * alarmB + fi * foodB + ti * toxinB + pi * preyB;

        const idx4 = i * 4;
        data[idx4] = Math.min(255, r);
        data[idx4 + 1] = Math.min(255, g);
        data[idx4 + 2] = Math.min(255, b);
        data[idx4 + 3] = 255;
      }
    }

    this.ctx.putImageData(this.imageData, 0, 0);
  }
}
