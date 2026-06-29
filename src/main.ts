import { Renderer } from './client/Renderer';
import { WebGPUDiffusion } from './client/WebGPUDiffusion';
import { LLM_CHEMICALS, type Ant, type SimulationState } from './engine/types';

const canvas = document.getElementById('sim') as HTMLCanvasElement;
const statsEl = document.getElementById('stats') as HTMLElement;

const antImage = new Image();
antImage.src = '/ant.svg';

const restartBtn = document.getElementById('restart') as HTMLButtonElement;
const snapshotToggle = document.getElementById('snapshot-toggle') as HTMLButtonElement;
const editPromptBtn = document.getElementById('edit-prompt') as HTMLButtonElement;

const promptModal = document.getElementById('prompt-modal') as HTMLDivElement;
const promptModalClose = document.getElementById('prompt-modal-close') as HTMLSpanElement;
const promptModalCancel = document.getElementById('prompt-modal-cancel') as HTMLButtonElement;
const promptModalSave = document.getElementById('prompt-modal-save') as HTMLButtonElement;
const promptEditor = document.getElementById('prompt-editor') as HTMLTextAreaElement;
const senseCheckboxes = document.querySelectorAll('.sense-checkbox') as NodeListOf<HTMLInputElement>;

const modal = document.getElementById('ant-modal') as HTMLDivElement;
const modalBackdrop = document.getElementById('modal-backdrop') as HTMLDivElement;
const modalClose = document.getElementById('ant-modal-close') as HTMLSpanElement;
const modalTitle = document.getElementById('ant-modal-title') as HTMLHeadingElement;
const modalBadges = document.getElementById('ant-modal-badges') as HTMLDivElement;
const modalSensesBody = document.querySelector('#ant-modal-senses tbody') as HTMLTableSectionElement;
const modalNearestFood = document.getElementById('ant-modal-nearest-food') as HTMLDivElement;
const modalTrail = document.getElementById('ant-modal-trail') as HTMLCanvasElement;
const trailTooltip = document.getElementById('trail-tooltip') as HTMLDivElement;

let state: SimulationState | null = null;
let previousState: SimulationState | null = null;
let lastStateTime = 0;
const SERVER_TICK_MS = 50;
let renderer: Renderer | null = null;
let diffusion: WebGPUDiffusion | null = null;
let webgpuReady = false;
let serverFallbackImage: HTMLImageElement | null = null;
let useSnapshot = true;

let currentSystemPrompt = '';
let currentActiveSenses: string[] = [...LLM_CHEMICALS];

// Per-ant movement history for the modal trail (last 120 ticks).
const HISTORY_LIMIT = 120;
const antHistory = new Map<string, { x: number; y: number; tick: number }[]>();
const antDecisions = new Map<string, { x: number; y: number; tick: number; direction: string }[]>();
const lastTargetDirection = new Map<string, string>();
let lastProcessedTick = -1;
let modalAntId: string | null = null;
let lastTrailPins: { x: number; y: number; direction: string; tick: number }[] = [];

const wsUrl = import.meta.env.DEV
  ? 'ws://localhost:3000'
  : `ws://${window.location.host}`;

const ws = new WebSocket(wsUrl);

function log(msg: string): void {
  console.log(`[ant-sim] ${msg}`);
}

function updateStatus(msg: string): void {
  statsEl.innerHTML = msg;
}

ws.addEventListener('open', () => {
  log('Connected to simulation server');
  updateStatus('Connected. Waiting for world state...');
  renderer?.setStatus('Connected. Waiting for world state...');
  restartBtn.disabled = false;
  snapshotToggle.disabled = false;
  editPromptBtn.disabled = false;
});

restartBtn.addEventListener('click', () => {
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ type: 'restart' }));
    log('Restart requested');
  }
});

ws.addEventListener('message', (event) => {
  const message = JSON.parse(event.data);

  if (message.type === 'init') {
    state = message.state as SimulationState;
    log(`Init: ${state.ants.length} ants, ${state.gaps.length} gaps`);

    // Wipe the GPU chemical field and history when the server starts or restarts a world.
    diffusion?.clear();
    antHistory.clear();
    antDecisions.clear();
    lastTargetDirection.clear();
    lastProcessedTick = -1;
    closeAntModal();

    if (typeof message.prompt === 'string') {
      currentSystemPrompt = message.prompt;
    }
    if (Array.isArray(message.activeSenses)) {
      currentActiveSenses = message.activeSenses;
    }

    if (message.chemicals) {
      loadSnapshot(message.chemicals);
    }

    initRenderer();
    renderer?.setStatus('Waiting for first LLM tick...');
  } else if (message.type === 'tick') {
    previousState = state;
    state = message.state as SimulationState;
    lastStateTime = performance.now();
    renderer?.setStatus('Running');
  } else if (message.type === 'chemicals') {
    loadSnapshot(message.chemicals);
  }
});

ws.addEventListener('close', () => {
  log('Disconnected from simulation server');
  updateStatus('Disconnected from server.');
  renderer?.setStatus('Disconnected from server');
  restartBtn.disabled = true;
  snapshotToggle.disabled = true;
  editPromptBtn.disabled = true;
});

ws.addEventListener('error', (err) => {
  console.error('[ant-sim] WebSocket error:', err);
  updateStatus('WebSocket error. Is the server running?');
  renderer?.setStatus('WebSocket error — is the server running?');
  restartBtn.disabled = true;
  snapshotToggle.disabled = true;
  editPromptBtn.disabled = true;
});

function loadSnapshot(src: string): void {
  serverFallbackImage = new Image();
  serverFallbackImage.src = src;
  serverFallbackImage.onload = () => {
    renderer?.setChemicalImage(serverFallbackImage!);
    if (useSnapshot) {
      renderer?.setPreferSnapshot(true);
    }
  };
}

function updateChemicalSource(): void {
  if (useSnapshot) {
    renderer?.setChemicalSource('server snapshot');
  } else if (webgpuReady) {
    renderer?.setChemicalSource('WebGPU + snapshot');
  } else {
    renderer?.setChemicalSource('server snapshot');
  }
}

function setUseSnapshot(value: boolean): void {
  useSnapshot = value;
  snapshotToggle.textContent = useSnapshot ? 'Using snapshot' : 'Use snapshot';
  snapshotToggle.style.background = useSnapshot
    ? 'rgba(0, 255, 136, 0.25)'
    : 'rgba(20, 20, 20, 0.8)';
  renderer?.setPreferSnapshot(useSnapshot);
  updateChemicalSource();
}

function initRenderer(): void {
  if (renderer) return;

  renderer = new Renderer(canvas, antImage, statsEl);
  if (serverFallbackImage && serverFallbackImage.complete) {
    renderer.setChemicalImage(serverFallbackImage);
  }

  snapshotToggle.addEventListener('click', () => {
    setUseSnapshot(!useSnapshot);
  });

  canvas.addEventListener('mousemove', (e) => {
    if (!renderer) return;
    const world = renderer.screenToWorld(e.clientX, e.clientY);
    renderer.setMousePos(world.x, world.y);
  });

  canvas.addEventListener('mouseleave', () => {
    renderer?.setMousePos(-1, -1);
  });

  canvas.addEventListener('click', () => {
    if (!renderer || !state) return;
    const ant = renderer.getHoveredAnt(state);
    if (ant) {
      openAntModal(ant);
    }
  });

  modalClose.addEventListener('click', closeAntModal);
  modalBackdrop.addEventListener('click', closeAntModal);
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      closeAntModal();
      closePromptModal();
    }
  });

  editPromptBtn.addEventListener('click', openPromptModal);
  promptModalClose.addEventListener('click', closePromptModal);
  promptModalCancel.addEventListener('click', closePromptModal);
  promptModalSave.addEventListener('click', savePromptModal);

  modalTrail.addEventListener('mousemove', (e) => {
    const rect = modalTrail.getBoundingClientRect();
    const mx = e.clientX - rect.left;
    const my = e.clientY - rect.top;
    const hitRadius = 8;
    let hit: { x: number; y: number; direction: string; tick: number } | null = null;
    for (const pin of lastTrailPins) {
      const dx = pin.x - mx;
      const dy = pin.y - my;
      if (dx * dx + dy * dy <= hitRadius * hitRadius) {
        hit = pin;
        break;
      }
    }
    if (hit) {
      trailTooltip.style.display = 'block';
      trailTooltip.textContent = `LLM said ${hit.direction} @ tick ${hit.tick}`;
      trailTooltip.style.left = `${modalTrail.offsetLeft + mx + 10}px`;
      trailTooltip.style.top = `${modalTrail.offsetTop + my - 20}px`;
    } else {
      trailTooltip.style.display = 'none';
    }
  });

  modalTrail.addEventListener('mouseleave', () => {
    trailTooltip.style.display = 'none';
  });

  initDiffusion();
  requestAnimationFrame(loop);
}

async function initDiffusion(): Promise<void> {
  diffusion = new WebGPUDiffusion();
  const ok = await diffusion.init();
  if (ok && diffusion.getCanvas()) {
    webgpuReady = true;
    renderer?.setChemicalCanvas(diffusion.getCanvas()!);
    log('WebGPU diffusion ready (1500x1000)');
  } else {
    diffusion = null;
    webgpuReady = false;
    log('WebGPU not available; using server snapshots');
    updateStatus('WebGPU unavailable. Using server snapshots.');
  }
  // Default to the proven-visible server snapshot overlay.
  setUseSnapshot(useSnapshot);
}

function updateHistory(): void {
  if (!state || state.tick === lastProcessedTick) return;
  lastProcessedTick = state.tick;

  for (const ant of state.ants) {
    let h = antHistory.get(ant.id);
    if (!h) {
      h = [];
      antHistory.set(ant.id, h);
    }
    h.push({ x: ant.x, y: ant.y, tick: state.tick });
    if (h.length > HISTORY_LIMIT) h.shift();

    const prevDir = lastTargetDirection.get(ant.id);
    const currentDir = ant.targetDirection;
    if (currentDir && currentDir !== prevDir) {
      let d = antDecisions.get(ant.id);
      if (!d) {
        d = [];
        antDecisions.set(ant.id, d);
      }
      d.push({ x: ant.x, y: ant.y, tick: state.tick, direction: currentDir });
      if (d.length > HISTORY_LIMIT) d.shift();
      lastTargetDirection.set(ant.id, currentDir);
    }
  }
}

function renderSensesTable(ant: Ant): void {
  modalSensesBody.innerHTML = '';
  const senses = ant.lastSenses;
  if (!senses) {
    modalSensesBody.innerHTML = '<tr><td colspan="3">no sense data yet</td></tr>';
    modalNearestFood.textContent = '';
    return;
  }

  for (const chem of LLM_CHEMICALS) {
    const point = senses.senses.smell_points[chem];
    const row = document.createElement('tr');
    row.innerHTML = `
      <td>${chem}</td>
      <td class="num">${point ? point.coming_from : '—'}</td>
      <td class="num">${point ? point.strength.toFixed(2) : '—'}</td>
    `;
    modalSensesBody.appendChild(row);
  }

  modalNearestFood.textContent = '';
}

function renderTrail(ant: Ant): void {
  const ctx = modalTrail.getContext('2d')!;
  const w = modalTrail.width;
  const h = modalTrail.height;
  ctx.fillStyle = '#080808';
  ctx.fillRect(0, 0, w, h);

  if (!state) return;

  const history = antHistory.get(ant.id) || [];
  if (history.length < 2) {
    ctx.fillStyle = '#00ff88';
    ctx.font = '12px monospace';
    ctx.fillText('collecting trail...', 10, h / 2);
    return;
  }

  // Determine bounds with padding around the trail and key landmarks.
  let minX = state.nestX;
  let maxX = state.nestX;
  let minY = state.nestY;
  let maxY = state.nestY;
  for (const p of history) {
    minX = Math.min(minX, p.x);
    maxX = Math.max(maxX, p.x);
    minY = Math.min(minY, p.y);
    maxY = Math.max(maxY, p.y);
  }
  for (const food of state.foods) {
    minX = Math.min(minX, food.x);
    maxX = Math.max(maxX, food.x);
    minY = Math.min(minY, food.y);
    maxY = Math.max(maxY, food.y);
  }

  const pad = 20;
  const rangeX = Math.max(1, maxX - minX);
  const rangeY = Math.max(1, maxY - minY);
  const scaleX = (w - pad * 2) / rangeX;
  const scaleY = (h - pad * 2) / rangeY;
  const scale = Math.min(scaleX, scaleY);
  const offX = (w - rangeX * scale) / 2 - minX * scale;
  const offY = (h - rangeY * scale) / 2 - minY * scale;

  const tx = (x: number) => x * scale + offX;
  const ty = (y: number) => y * scale + offY;

  // Trail.
  ctx.strokeStyle = '#00ff88';
  ctx.lineWidth = 2;
  ctx.beginPath();
  for (let i = 0; i < history.length; i++) {
    const p = history[i];
    if (i === 0) ctx.moveTo(tx(p.x), ty(p.y));
    else ctx.lineTo(tx(p.x), ty(p.y));
  }
  ctx.stroke();

  // Nest.
  ctx.fillStyle = '#2a73ff';
  ctx.beginPath();
  ctx.arc(tx(state.nestX), ty(state.nestY), 5, 0, Math.PI * 2);
  ctx.fill();

  // Foods.
  for (const food of state.foods) {
    ctx.fillStyle = '#fff23a';
    ctx.beginPath();
    ctx.arc(tx(food.x), ty(food.y), 4, 0, Math.PI * 2);
    ctx.fill();
  }

  // Current ant position.
  ctx.fillStyle = '#ff5724';
  ctx.beginPath();
  ctx.arc(tx(ant.x), ty(ant.y), 5, 0, Math.PI * 2);
  ctx.fill();

  // Decision pins: mark where the ant received a new direction command.
  const directionColor: Record<string, string> = {
    forward: '#ffffff',
    'forward left': '#aaffaa',
    left: '#00ff00',
    'hard left': '#008800',
    'forward right': '#ffaaaa',
    right: '#ff0000',
    'hard right': '#880000',
  };

  const pins: { x: number; y: number; direction: string; tick: number }[] = [];
  const decisions = antDecisions.get(ant.id) || [];
  const oldestTick = history[0].tick;
  for (const d of decisions) {
    if (d.tick < oldestTick) continue;
    const px = tx(d.x);
    const py = ty(d.y);
    pins.push({ x: px, y: py, direction: d.direction, tick: d.tick });
    ctx.fillStyle = directionColor[d.direction] ?? '#00ff88';
    ctx.strokeStyle = '#000000';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.arc(px, py, 4, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
  }
  lastTrailPins = pins;
}

function openAntModal(ant: Ant): void {
  modalAntId = ant.id;
  renderer?.selectAnt(ant.id);
  modalTitle.textContent = `${ant.id} — details`;

  modalBadges.innerHTML = `
    <span class="badge">energy ${ant.energy.toFixed(0)}</span>
    <span class="badge">hunger ${ant.hunger.toFixed(0)}</span>
    <span class="badge">speed ${ant.speed.toFixed(1)}</span>
    ${ant.carryingFood ? '<span class="badge">carrying food</span>' : ''}
    ${ant.inToxicArea ? '<span class="badge">toxic area</span>' : ''}
  `;

  renderSensesTable(ant);
  renderTrail(ant);

  modal.style.display = 'block';
  modalBackdrop.style.display = 'block';
}

function closeAntModal(): void {
  modalAntId = null;
  renderer?.selectAnt(null);
  modal.style.display = 'none';
  modalBackdrop.style.display = 'none';
  trailTooltip.style.display = 'none';
  lastTrailPins = [];
}

function openPromptModal(): void {
  promptEditor.value = currentSystemPrompt;
  for (const cb of senseCheckboxes) {
    cb.checked = currentActiveSenses.includes(cb.value);
  }
  promptModal.style.display = 'block';
  modalBackdrop.style.display = 'block';
}

function closePromptModal(): void {
  promptModal.style.display = 'none';
  if (modalAntId === null) {
    modalBackdrop.style.display = 'none';
  }
}

function savePromptModal(): void {
  const activeSenses = Array.from(senseCheckboxes)
    .filter((cb) => cb.checked)
    .map((cb) => cb.value);
  ws.send(
    JSON.stringify({
      type: 'updateConfig',
      systemPrompt: promptEditor.value,
      activeSenses,
    })
  );
  closePromptModal();
  log('Updated system prompt and restarted');
}

function refreshModal(): void {
  if (!modalAntId || !state) return;
  const ant = state.ants.find((a) => a.id === modalAntId);
  if (!ant) {
    closeAntModal();
    return;
  }
  renderSensesTable(ant);
  renderTrail(ant);
}

let frameCount = 0;
let gpuErrorCount = 0;
function loop() {
  if (state && renderer) {
    try {
      updateHistory();

      // Only run the GPU diffusion path when the user explicitly wants it.
      if (diffusion && !useSnapshot) {
        diffusion.depositAnts(state.ants, state.config.width, state.config.height);
        diffusion.step();
      }
      const alpha = Math.min(1, (performance.now() - lastStateTime) / SERVER_TICK_MS);
      renderer.render(state, previousState ?? undefined, alpha);
      refreshModal();
      gpuErrorCount = 0;

      frameCount++;
      if (frameCount % 120 === 0) {
        log(
          `tick=${state.tick} ants=${state.ants.length} carrying=${state.ants.filter((a) => a.carryingFood).length} webgpu=${webgpuReady}`
        );
      }
    } catch (err) {
      console.error('[ant-sim] render loop error:', err);
      if (diffusion && err instanceof Error && /gpu|webgpu|writebuffer/i.test(err.message)) {
        gpuErrorCount++;
        if (gpuErrorCount > 3) {
          log('WebGPU is failing; switching back to server snapshot.');
          setUseSnapshot(true);
        }
      }
    }
  }
  requestAnimationFrame(loop);
}
