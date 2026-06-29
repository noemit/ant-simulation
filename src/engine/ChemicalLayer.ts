export interface LayerRates {
  diffusionRate: number;
  evaporationRate: number;
}

export class ChemicalLayer {
  readonly width: number;
  readonly height: number;
  readonly diffusionRate: number;
  readonly evaporationRate: number;
  current: Float32Array;
  next: Float32Array;

  constructor(
    width: number,
    height: number,
    rates: Partial<LayerRates> = {}
  ) {
    this.width = width;
    this.height = height;
    this.diffusionRate = rates.diffusionRate ?? 0.15;
    this.evaporationRate = rates.evaporationRate ?? 0.02;
    this.current = new Float32Array(width * height);
    this.next = new Float32Array(width * height);
  }

  idx(x: number, y: number): number {
    return y * this.width + x;
  }

  /**
   * Deposit chemical at floating-point grid coordinates using bilinear weighting.
   */
  deposit(gx: number, gy: number, amount: number): void {
    if (amount <= 0) return;

    const x0 = Math.floor(gx);
    const y0 = Math.floor(gy);
    const x1 = x0 + 1;
    const y1 = y0 + 1;

    const wx = gx - x0;
    const wy = gy - y0;

    const w00 = (1 - wx) * (1 - wy);
    const w10 = wx * (1 - wy);
    const w01 = (1 - wx) * wy;
    const w11 = wx * wy;

    this.addIfInside(x0, y0, amount * w00);
    this.addIfInside(x1, y0, amount * w10);
    this.addIfInside(x0, y1, amount * w01);
    this.addIfInside(x1, y1, amount * w11);
  }

  private addIfInside(x: number, y: number, amount: number): void {
    if (x >= 0 && x < this.width && y >= 0 && y < this.height) {
      this.current[this.idx(x, y)] += amount;
    }
  }

  /**
   * Sample the chemical field at floating-point grid coordinates using bilinear interpolation.
   */
  sample(gx: number, gy: number): number {
    const x0 = Math.floor(gx);
    const y0 = Math.floor(gy);
    const x1 = x0 + 1;
    const y1 = y0 + 1;

    const wx = gx - x0;
    const wy = gy - y0;

    const v00 = this.getClamped(x0, y0);
    const v10 = this.getClamped(x1, y0);
    const v01 = this.getClamped(x0, y1);
    const v11 = this.getClamped(x1, y1);

    return (
      v00 * (1 - wx) * (1 - wy) +
      v10 * wx * (1 - wy) +
      v01 * (1 - wx) * wy +
      v11 * wx * wy
    );
  }

  private getClamped(x: number, y: number): number {
    const cx = Math.max(0, Math.min(this.width - 1, x));
    const cy = Math.max(0, Math.min(this.height - 1, y));
    return this.current[this.idx(cx, cy)];
  }

  /**
   * Compute the gradient vector at floating-point grid coordinates.
   * Returns a unit-ish vector pointing toward the steepest ascent.
   */
  gradient(gx: number, gy: number): { x: number; y: number } {
    const dx = this.sample(gx + 1, gy) - this.sample(gx - 1, gy);
    const dy = this.sample(gx, gy + 1) - this.sample(gx, gy - 1);
    const len = Math.hypot(dx, dy);
    if (len < 1e-6) return { x: 0, y: 0 };
    return { x: dx / len, y: dy / len };
  }

  /**
   * Apply one diffusion + evaporation step using a separable convolution.
   */
  step(): void {
    const w = this.width;
    const h = this.height;
    const src = this.current;
    const tmp = this.next;

    const keep = 1 - this.diffusionRate;
    const side = this.diffusionRate * 0.5;

    // Horizontal pass: tmp = horizontal_blur(src) * (1 - evaporation)
    const survive = 1 - this.evaporationRate;
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const left = x > 0 ? src[this.idx(x - 1, y)] : 0;
        const center = src[this.idx(x, y)];
        const right = x < w - 1 ? src[this.idx(x + 1, y)] : 0;
        tmp[this.idx(x, y)] = (left * side + center * keep + right * side) * survive;
      }
    }

    // Vertical pass: src = vertical_blur(tmp)
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const up = y > 0 ? tmp[this.idx(x, y - 1)] : 0;
        const center = tmp[this.idx(x, y)];
        const down = y < h - 1 ? tmp[this.idx(x, y + 1)] : 0;
        src[this.idx(x, y)] = up * side + center * keep + down * side;
      }
    }
  }

  /**
   * Zero out the entire layer.
   */
  clear(): void {
    this.current.fill(0);
    this.next.fill(0);
  }
}
