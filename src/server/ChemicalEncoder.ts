import { PNG } from 'pngjs';
import type { World } from '../engine/World';
import type { ChemicalType } from '../engine/types';

const COLORS: Record<ChemicalType, { r: number; g: number; b: number }> = {
  raid_trail: { r: 200, g: 60, b: 20 },
  mandibular_alarm: { r: 255, g: 20, b: 60 },
  food_trail: { r: 20, g: 80, b: 220 },
  toxin_scent: { r: 120, g: 220, b: 40 },
  prey_scent: { r: 240, g: 220, b: 40 },
};

/**
 * Encode the world's chemical layers as a PNG image.
 * Returns a base64 data URL.
 */
export function encodeChemicals(world: World): string {
  const w = world.config.gridWidth;
  const h = world.config.gridHeight;
  const png = new PNG({ width: w, height: h });

  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const idx = (y * w + x) * 4;
      let r = 0;
      let g = 0;
      let b = 0;

      for (const [type, layer] of Object.entries(world.layers) as [
        ChemicalType,
        { current: Float32Array }
      ][]) {
        const value = layer.current[y * w + x];
        const intensity = Math.min(1, value * 1.0);
        const color = COLORS[type];
        r += color.r * intensity;
        g += color.g * intensity;
        b += color.b * intensity;
      }

      png.data[idx] = Math.min(255, r);
      png.data[idx + 1] = Math.min(255, g);
      png.data[idx + 2] = Math.min(255, b);
      png.data[idx + 3] = 255;
    }
  }

  const buffer = PNG.sync.write(png);
  return 'data:image/png;base64,' + buffer.toString('base64');
}
