import 'dotenv/config';
import express from 'express';
import { createServer } from 'http';
import { WebSocketServer, WebSocket } from 'ws';
import path from 'path';
import { fileURLToPath } from 'url';
import { World } from '../engine/World';
import { MockOrchestrator } from '../engine/MockOrchestrator';
import type { SimulationState, WorldConfig, Ant, AntTarget } from '../engine/types';
import { encodeChemicals } from './ChemicalEncoder';
import { LLMClient } from './llm/LLMClient';
import { LLMOrchestrator } from './llm/LLMOrchestrator';
import { systemPrompt, setSystemPrompt as setBuilderSystemPrompt } from './llm/PromptBuilder';
import { setActiveChemicals } from '../engine/payload';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function envInt(name: string, fallback: number): number {
  const value = process.env[name];
  return value ? parseInt(value, 10) : fallback;
}

function envString(name: string, fallback: string): string {
  return process.env[name] || fallback;
}

const config: WorldConfig = {
  width: 600,
  height: 400,
  gridWidth: 600,
  gridHeight: 400,
  // Default to a small colony so we can ask the LLM for fresh decisions every tick.
  antCount: envInt('ANT_COUNT', 30),
  diffusionRate: 0.15,
  evaporationRate: 0.02,
  energyCostFactor: 0.08,
  maxSpeed: 5,
  minSpeed: 0.5,
  startingEnergy: 100,
  antRadius: 3,
  foodCount: 6,
  hazardCount: 2,
  gapCount: 2,
};

const SIMULATION_HZ = 20;
const DT = 1 / SIMULATION_HZ;
const MS_PER_TICK = 1000 / SIMULATION_HZ;

let world = new World(config);
const mock = new MockOrchestrator();

// Latest goals returned by the LLM. Ants reuse their last target until a new
// batch arrives, so the physics tick never waits on the network.
const latestTargets = new Map<string, AntTarget>();
let lastLLMCallAt = 0;
let llmInFlight = false;
const LLM_DECISION_INTERVAL_MS = envInt('LLM_DECISION_INTERVAL_MS', 500);

let currentSystemPrompt = systemPrompt;
let currentActiveSenses: ('raid_trail' | 'food_trail' | 'toxin_scent')[] = ['raid_trail', 'food_trail', 'toxin_scent'];

function restartWorld(): void {
  world = new World(config);
  latestTargets.clear();
  lastLLMCallAt = 0;
  lastChemicalTick = 0;
  console.log('World restarted');
}

// Fallback controller used only when no LLM_API_KEY is configured.
function fallbackController(ant: Ant, world: World) {
  return mock.decide(ant, world);
}

const apiKey = process.env.LLM_API_KEY;
const useLLM = Boolean(apiKey && apiKey !== 'your-api-key-here');

let llmOrchestrator: LLMOrchestrator | null = null;

if (useLLM) {
  const client = new LLMClient({
    apiKey: apiKey!,
    baseURL: envString('LLM_BASE_URL', 'https://api.openai.com/v1'),
    model: envString('LLM_MODEL', 'gpt-4o-mini'),
    timeoutMs: envInt('LLM_TIMEOUT_MS', 10000),
    maxRetries: envInt('LLM_MAX_RETRIES', 0),
  });
  // One request for all ants, one at a time. The physics tick never awaits this.
  llmOrchestrator = new LLMOrchestrator(
    client,
    config.antCount,
    1,
    (ant) => getFallbackTarget(ant),
    envInt('LLM_BATCH_TIMEOUT_MS', 10000),
    true
  );
  llmOrchestrator.setSystemPrompt(currentSystemPrompt);
  console.log(
    `LLM orchestrator enabled: ${process.env.LLM_MODEL || 'gpt-4o-mini'}, ` +
      `one batch of ${config.antCount} ants every ${LLM_DECISION_INTERVAL_MS}ms`
  );
} else {
  console.log('No LLM_API_KEY found. Running with mock orchestrator only.');
}

const app = express();
const server = createServer(app);
const wss = new WebSocketServer({ server });

app.use(express.static(path.join(__dirname, '../../dist')));

function buildState(): SimulationState {
  return {
    config: world.config,
    ants: world.ants,
    foods: world.foods,
    hazards: world.hazards,
    gaps: world.gaps,
    nestX: world.nestX,
    nestY: world.nestY,
    tick: world.tickCount,
  };
}

function broadcast(message: object): void {
  const json = JSON.stringify(message);
  for (const client of wss.clients) {
    if (client.readyState === WebSocket.OPEN) {
      client.send(json);
    }
  }
}

wss.on('connection', (ws) => {
  console.log('Client connected');

  function sendInit(targetWs: WebSocket = ws): void {
    targetWs.send(
      JSON.stringify({
        type: 'init',
        state: buildState(),
        chemicals: encodeChemicals(world),
        prompt: currentSystemPrompt,
        activeSenses: currentActiveSenses,
      })
    );
  }

  sendInit();

  ws.on('message', (data) => {
    try {
      const message = JSON.parse(data.toString());
      if (message.type === 'restart') {
        restartWorld();
        sendInit();
      } else if (message.type === 'updateConfig') {
        const newPrompt = message.systemPrompt !== undefined ? String(message.systemPrompt) : currentSystemPrompt;
        const allowedSenses = ['raid_trail', 'food_trail', 'toxin_scent'];
        const newSenses: ('raid_trail' | 'food_trail' | 'toxin_scent')[] = Array.isArray(message.activeSenses)
          ? message.activeSenses.filter((s: string) => allowedSenses.includes(s))
          : currentActiveSenses;

        currentSystemPrompt = newPrompt;
        currentActiveSenses = newSenses;
        setBuilderSystemPrompt(newPrompt);
        setActiveChemicals(newSenses);
        llmOrchestrator?.setSystemPrompt(newPrompt);
        restartWorld();
        broadcast({
          type: 'init',
          state: buildState(),
          chemicals: encodeChemicals(world),
          prompt: currentSystemPrompt,
          activeSenses: currentActiveSenses,
        });
        console.log('Updated config and restarted; active senses:', newSenses.join(', '));
      }
    } catch {
      // Ignore malformed messages.
    }
  });

  ws.on('close', () => {
    console.log('Client disconnected');
  });
});

let lastChemicalTick = 0;
let running = true;

async function fetchLLMDecisions(): Promise<void> {
  if (!llmOrchestrator || llmInFlight) return;

  const now = performance.now();
  if (now - lastLLMCallAt < LLM_DECISION_INTERVAL_MS) return;

  llmInFlight = true;
  lastLLMCallAt = now;

  try {
    const decisions = await llmOrchestrator.decideAll(world.ants, world);
    for (const [antId, target] of decisions) {
      latestTargets.set(antId, target);
    }
  } catch (err) {
    console.error('LLM decision failed:', err);
  } finally {
    llmInFlight = false;
  }
}

function getFallbackTarget(ant: Ant): AntTarget {
  // Never return 'forward'; ants must curve slightly.
  const dir = ant.targetDirection;
  return {
    direction: dir && dir !== 'forward' ? dir : (Math.random() < 0.5 ? 'forward left' : 'forward right'),
    speed: world.config.maxSpeed * 0.7,
  };
}

async function tickLoop(): Promise<void> {
  while (running) {
    const tickStart = performance.now();

    // Fire an LLM request asynchronously if it's time. The physics tick below
    // will use whatever targets are already in latestTargets.
    if (llmOrchestrator) {
      fetchLLMDecisions();
    }

    world.tick(DT, (ant) => {
      if (llmOrchestrator) {
        // LLM mode: use the latest target. If none exists yet, fall back to straight ahead.
        return latestTargets.get(ant.id) ?? getFallbackTarget(ant);
      }
      return fallbackController(ant, world);
    });

    broadcast({ type: 'tick', state: buildState() });

    // Low-frequency chemical snapshot used by the client overlay.
    if (world.tickCount - lastChemicalTick >= 20) {
      lastChemicalTick = world.tickCount;
      broadcast({ type: 'chemicals', chemicals: encodeChemicals(world) });
    }

    const elapsed = performance.now() - tickStart;
    const delay = Math.max(0, MS_PER_TICK - elapsed);

    if (llmOrchestrator && elapsed > MS_PER_TICK * 2) {
      const metrics = llmOrchestrator.getMetrics();
      console.warn(
        `Tick ${world.tickCount} took ${elapsed.toFixed(0)}ms ` +
          `(batches=${metrics.lastTickBatches}, avg latency=${(
            metrics.totalLatencyMs / metrics.totalCalls
          ).toFixed(0)}ms)`
      );
    }

    await new Promise((resolve) => setTimeout(resolve, delay));
  }
}

tickLoop().catch((err) => {
  console.error('Simulation loop crashed:', err);
  process.exit(1);
});

let port = envInt('PORT', 3000);
const MAX_PORT_ATTEMPTS = 3090;
let retrying = false;

function tryNextPort(): void {
  if (retrying) return;
  retrying = true;
  if (port >= MAX_PORT_ATTEMPTS) {
    console.error(`No free port found up to ${MAX_PORT_ATTEMPTS}`);
    process.exit(1);
  }
  console.log(`Port ${port} in use, trying ${port + 10}...`);
  port += 10;
  setTimeout(() => {
    retrying = false;
    server.listen(port);
  }, 0);
}

function onListenError(err: NodeJS.ErrnoException): void {
  if (err.code === 'EADDRINUSE') {
    tryNextPort();
  } else {
    console.error('Server failed to start:', err);
    process.exit(1);
  }
}

server.on('error', onListenError);
wss.on('error', onListenError);

server.listen(port, () => {
  console.log(`Server listening on http://localhost:${port}`);
});

process.on('SIGINT', () => {
  running = false;
  server.close(() => process.exit(0));
});
