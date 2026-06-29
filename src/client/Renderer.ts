import type { Ant, SimulationState } from '../engine/types';

export class Renderer {
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private antImage: HTMLImageElement;
  private statsEl: HTMLElement;
  private chemicalImage: HTMLImageElement | null = null;
  private chemicalCanvas: HTMLCanvasElement | null = null;
  private preferSnapshot = false;

  private lastFrameTime = performance.now();
  private frameCount = 0;
  private fps = 0;
  private statusText = 'Initializing...';
  private chemicalSourceText = 'none';

  // Latest viewport transform for screen<->world mapping.
  private scale = 1;
  private offsetX = 0;
  private offsetY = 0;

  // Mouse position in world coordinates (-1 = unset).
  private mouseWorldX = -1;
  private mouseWorldY = -1;

  // Ant currently selected via click (for the modal).
  private selectedAntId: string | null = null;

  constructor(
    canvas: HTMLCanvasElement,
    antImage: HTMLImageElement,
    statsEl: HTMLElement
  ) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d', { alpha: false })!;
    this.antImage = antImage;
    this.statsEl = statsEl;

    this.resize();
    window.addEventListener('resize', () => this.resize());
  }

  setMousePos(x: number, y: number): void {
    this.mouseWorldX = x;
    this.mouseWorldY = y;
  }

  selectAnt(id: string | null): void {
    this.selectedAntId = id;
  }

  getSelectedAntId(): string | null {
    return this.selectedAntId;
  }

  screenToWorld(sx: number, sy: number): { x: number; y: number } {
    return {
      x: (sx - this.offsetX) / this.scale,
      y: (sy - this.offsetY) / this.scale,
    };
  }

  worldToScreen(wx: number, wy: number): { x: number; y: number } {
    return {
      x: wx * this.scale + this.offsetX,
      y: wy * this.scale + this.offsetY,
    };
  }

  getHoveredAnt(state: SimulationState): Ant | null {
    if (this.mouseWorldX < 0 || this.mouseWorldY < 0) return null;

    let best: Ant | null = null;
    let bestDist = Infinity;
    const threshold = 10;

    for (const ant of state.ants) {
      const d = Math.hypot(ant.x - this.mouseWorldX, ant.y - this.mouseWorldY);
      if (d < threshold && d < bestDist) {
        bestDist = d;
        best = ant;
      }
    }
    return best;
  }

  setChemicalImage(image: HTMLImageElement): void {
    this.chemicalImage = image;
  }

  setChemicalCanvas(canvas: HTMLCanvasElement): void {
    this.chemicalCanvas = canvas;
  }

  setPreferSnapshot(prefer: boolean): void {
    this.preferSnapshot = prefer;
  }

  setStatus(text: string): void {
    this.statusText = text;
  }

  setChemicalSource(text: string): void {
    this.chemicalSourceText = text;
  }

  private resize(): void {
    this.canvas.width = window.innerWidth;
    this.canvas.height = window.innerHeight;
  }

  render(state: SimulationState, previousState?: SimulationState, alpha = 1): void {
    const now = performance.now();
    this.frameCount++;
    if (now - this.lastFrameTime >= 1000) {
      this.fps = Math.round((this.frameCount * 1000) / (now - this.lastFrameTime));
      this.frameCount = 0;
      this.lastFrameTime = now;
    }

    this.ctx.fillStyle = '#0a0a0a';
    this.ctx.fillRect(0, 0, this.canvas.width, this.canvas.height);

    const scaleX = this.canvas.width / state.config.width;
    const scaleY = this.canvas.height / state.config.height;
    this.scale = Math.min(scaleX, scaleY);
    this.offsetX = (this.canvas.width - state.config.width * this.scale) / 2;
    this.offsetY = (this.canvas.height - state.config.height * this.scale) / 2;

    this.ctx.save();
    this.ctx.translate(this.offsetX, this.offsetY);
    this.ctx.scale(this.scale, this.scale);

    // Use interpolated positions for visuals; authoritative state for static world data.
    const renderState = previousState ? this.interpolateState(previousState, state, alpha) : state;

    this.drawChemicals(state);
    this.drawNest(state);
    this.drawGaps(state);
    this.drawHazards(state);
    this.drawFoods(state);
    this.drawAnts(renderState);
    this.drawInspectHighlights(state);

    this.ctx.restore();

    this.drawTooltip(state);
    this.drawStats(state);
  }

  private interpolateState(prev: SimulationState, next: SimulationState, alpha: number): SimulationState {
    // Build a shallow copy with interpolated ant positions and headings.
    const antMap = new Map(next.ants.map((a) => [a.id, a]));
    const interpolatedAnts = prev.ants.map((prevAnt) => {
      const nextAnt = antMap.get(prevAnt.id);
      if (!nextAnt) return prevAnt;

      // Lerp position.
      const x = prevAnt.x + (nextAnt.x - prevAnt.x) * alpha;
      const y = prevAnt.y + (nextAnt.y - prevAnt.y) * alpha;

      // Lerp heading along the shortest angle.
      let headingDelta = nextAnt.heading - prevAnt.heading;
      while (headingDelta > Math.PI) headingDelta -= Math.PI * 2;
      while (headingDelta <= -Math.PI) headingDelta += Math.PI * 2;
      const heading = prevAnt.heading + headingDelta * alpha;

      return { ...nextAnt, x, y, heading };
    });

    return { ...next, ants: interpolatedAnts };
  }

  private drawChemicals(state: SimulationState): void {
    this.ctx.save();
    // Additive blending: zero-intensity areas (black) don't darken the background,
    // so ants/food/nest remain visible even before pheromones accumulate.
    this.ctx.globalCompositeOperation = 'lighter';

    // Always draw the latest server snapshot as a baseline so trails are visible
    // even if the WebGPU diffusion path is broken or disabled.
    if (this.chemicalImage && this.chemicalImage.complete) {
      this.ctx.globalAlpha = 0.85;
      this.ctx.drawImage(
        this.chemicalImage,
        0,
        0,
        state.config.width,
        state.config.height
      );
    }

    // Overlay the live WebGPU chemical field when available and not overridden.
    if (this.chemicalCanvas && !this.preferSnapshot) {
      this.ctx.globalAlpha = 0.85;
      this.ctx.drawImage(
        this.chemicalCanvas,
        0,
        0,
        state.config.width,
        state.config.height
      );
    }

    this.ctx.restore();
  }

  private drawNest(state: SimulationState): void {
    this.ctx.beginPath();
    this.ctx.arc(state.nestX, state.nestY, 25, 0, Math.PI * 2);
    this.ctx.fillStyle = 'rgba(20, 80, 200, 0.15)';
    this.ctx.fill();
    this.ctx.strokeStyle = 'rgba(20, 80, 200, 0.4)';
    this.ctx.lineWidth = 2;
    this.ctx.stroke();
  }

  private drawHazards(state: SimulationState): void {
    for (const hazard of state.hazards) {
      this.ctx.beginPath();
      this.ctx.arc(hazard.x, hazard.y, hazard.radius, 0, Math.PI * 2);
      this.ctx.fillStyle = 'rgba(120, 220, 40, 0.15)';
      this.ctx.fill();
      this.ctx.strokeStyle = 'rgba(120, 220, 40, 0.5)';
      this.ctx.lineWidth = 1.5;
      this.ctx.stroke();
    }
  }

  private drawGaps(state: SimulationState): void {
    for (const gap of state.gaps) {
      this.ctx.fillStyle = 'rgba(0, 0, 0, 0.5)';
      this.ctx.fillRect(gap.x, gap.y, gap.width, gap.height);
      this.ctx.strokeStyle = 'rgba(255, 255, 255, 0.15)';
      this.ctx.lineWidth = 1;
      this.ctx.strokeRect(gap.x, gap.y, gap.width, gap.height);
    }
  }

  private drawFoods(state: SimulationState): void {
    for (const food of state.foods) {
      this.ctx.beginPath();
      this.ctx.arc(food.x, food.y, food.radius, 0, Math.PI * 2);
      this.ctx.fillStyle = 'rgba(240, 220, 40, 0.8)';
      this.ctx.fill();
    }
  }

  private drawAnts(state: SimulationState): void {
    const antWidth = 12;
    const antHeight = 6;
    const imageReady = this.antImage.complete && this.antImage.naturalWidth > 0;
    const now = performance.now();

    for (const ant of state.ants) {
      this.ctx.save();
      this.ctx.translate(ant.x, ant.y);
      this.ctx.rotate(ant.heading);

      // Blink red when in a toxic/hazard area.
      const toxicBlink = ant.inToxicArea && Math.sin(now / 80) > 0;
      if (toxicBlink) {
        this.ctx.filter = 'drop-shadow(0 0 4px #ff0000)';
      }

      if (ant.hunger > 50) {
        this.ctx.fillStyle = '#ff8c4a';
      } else if (ant.carryingFood) {
        this.ctx.fillStyle = '#ff69b4';
      } else {
        this.ctx.fillStyle = '#e8e8e8';
      }

      if (imageReady) {
        this.ctx.drawImage(
          this.antImage,
          -antWidth / 2,
          -antHeight / 2,
          antWidth,
          antHeight
        );
      } else {
        // Fallback shape if the SVG hasn't loaded yet.
        this.ctx.beginPath();
        this.ctx.moveTo(antWidth / 2, 0);
        this.ctx.lineTo(-antWidth / 2, antHeight / 2);
        this.ctx.lineTo(-antWidth / 2, -antHeight / 2);
        this.ctx.closePath();
        this.ctx.fill();
      }

      this.ctx.filter = 'none';
      this.ctx.restore();
    }
  }

  private drawInspectHighlights(state: SimulationState): void {
    const hovered = this.getHoveredAnt(state);
    const target = hovered ??
      (this.selectedAntId
        ? state.ants.find((a) => a.id === this.selectedAntId) ?? null
        : null);
    if (!target) return;

    this.ctx.save();
    this.ctx.translate(target.x, target.y);
    this.ctx.beginPath();
    this.ctx.arc(0, 0, 14, 0, Math.PI * 2);
    this.ctx.strokeStyle = hovered && hovered.id === target.id ? '#00ff88' : '#44aaff';
    this.ctx.lineWidth = 2;
    this.ctx.setLineDash([4, 3]);
    this.ctx.stroke();
    this.ctx.restore();
  }

  private drawTooltip(state: SimulationState): void {
    const ant = this.getHoveredAnt(state);
    if (!ant) return;

    const lines: string[] = [
      ant.id,
      `spd:${ant.speed.toFixed(1)} nrg:${ant.energy.toFixed(0)} hgr:${ant.hunger.toFixed(0)}`,
      ant.carryingFood ? 'carrying food' : ant.inToxicArea ? 'in toxic area' : ant.lastAction,
      ant.lastSenses ? `goal: ${ant.lastSenses.internal_state.goal}` : 'no senses',
    ];

    const { x: sx, y: sy } = this.worldToScreen(ant.x, ant.y);
    const padding = 6;
    const lineHeight = 14;
    this.ctx.font = '12px ui-monospace, SFMono-Regular, Menlo, monospace';
    const widths = lines.map((l) => this.ctx.measureText(l).width);
    const boxW = Math.max(...widths) + padding * 2;
    const boxH = lines.length * lineHeight + padding * 2;

    let bx = sx + 18;
    let by = sy - 18 - boxH;
    if (bx + boxW > this.canvas.width) bx = sx - 18 - boxW;
    if (by < 0) by = sy + 18;

    this.ctx.save();
    this.ctx.fillStyle = 'rgba(10, 10, 10, 0.9)';
    this.ctx.strokeStyle = '#00ff88';
    this.ctx.lineWidth = 1;
    this.ctx.fillRect(bx, by, boxW, boxH);
    this.ctx.strokeRect(bx, by, boxW, boxH);

    this.ctx.fillStyle = '#00ff88';
    for (let i = 0; i < lines.length; i++) {
      this.ctx.fillText(lines[i], bx + padding, by + padding + (i + 1) * lineHeight - 3);
    }
    this.ctx.restore();
  }

  private drawStats(state: SimulationState): void {
    const avgEnergy =
      state.ants.reduce((sum, a) => sum + a.energy, 0) / state.ants.length;
    const avgHunger =
      state.ants.reduce((sum, a) => sum + a.hunger, 0) / state.ants.length;
    const toxic = state.ants.filter((a) => a.inToxicArea).length;
    const carrying = state.ants.filter((a) => a.carryingFood).length;
    const foodRemaining = state.foods.reduce((sum, f) => sum + f.amount, 0);

    this.statsEl.innerHTML = `
      <strong>${this.statusText}</strong><br>
      FPS: ${this.fps}<br>
      Tick: ${state.tick}<br>
      Ants: ${state.ants.length}<br>
      Avg energy: ${avgEnergy.toFixed(1)}<br>
      Avg hunger: ${avgHunger.toFixed(1)}<br>
      In toxic area: ${toxic}<br>
      Carrying food: ${carrying}<br>
      Food remaining: ${foodRemaining}<br>
      Chemicals: ${this.chemicalSourceText}
    `;
  }
}
