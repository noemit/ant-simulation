# Army Ant Swarm: Architecture & Development Plan

## What we're building

A browser-based 2D simulation where every army ant is an independent LLM agent. Ants are blind and navigate a continuous world using chemical gradients and tactile memory. Each ant chooses its heading, speed, and actions on every tick. Faster movement costs more energy; low energy raises hunger and biases the ant toward food. The engine diffuses five pheromone layers across a detailed grid, and a Canvas frontend renders up to 300 SVG ants in real time.

---

## 1. Tech stack

### Engine and runtime

**TypeScript** running in the browser for Phase 1. This keeps the build simple and lets us iterate quickly on movement, diffusion, and rendering without networking. Later phases move the engine to a Node.js server so the cloud LLM API key stays server-side.

**Vite** for bundling and the dev server. It gives us hot reload, TypeScript support, and a clean build output with minimal config.

### Diffusion

**Dense grid convolution in `Float32Array`** for the 600 × 400 prototype. We use a separable Gaussian kernel so the cost is `O(width * height * radius)` instead of `O(width * height * radius^2)`.

**WebGPU compute shaders** for the 3000 × 2000 target. The CPU version validates the behavior; the GPU version scales it. The chemical layer interface is the same in both implementations, so we swap solvers without touching ants or rendering.

### Rendering

**HTML5 Canvas 2D** for the world. Ants are drawn as cached SVG sprites rotated to their heading. Chemical layers are composited as low-opacity image layers behind the ants.

### LLM orchestration (Phase 3)

**Node.js + Express + WebSocket server**. Each tick, the server builds per-ant JSON payloads, sends batched or parallel calls to the OpenAI-compatible API, parses tool-call responses, and pushes a compact world diff to clients.

### Validation

**Zod** schemas for every LLM tool-call response.

---

## 2. World model

### Continuous space

Ants live in a continuous rectangle `(0, 0)` to `(worldWidth, worldHeight)`. The world is measured in the same units used for rendering, for example 1200 × 800 display pixels scaled to a 600 × 400 simulation world.

### Discrete chemical grid

Five chemical layers are stored as `Float32Array`s over a grid:

- `raid_trail`
- `mandibular_alarm`
- `bivouac_scent`
- `toxin_scent`
- `prey_scent`

Grid dimensions are configurable. We start at **600 × 400** and plan to scale to **3000 × 2000**. Each ant deposits pheromones at its continuous position by writing into the nearest grid cells with bilinear weighting.

### Ant state

```ts
interface Ant {
  id: string;
  x: number;
  y: number;
  heading: number;      // radians, 0 = East
  speed: number;        // units per tick
  energy: number;       // 0-100
  hunger: number;       // 0-100
  carryingFood: boolean;
  inToxicArea: boolean;
  lastAction: string;
  targetX?: number;     // LLM/fallback goal
  targetY?: number;
  targetSpeed?: number;
}
```

Energy depletion per tick: `energy -= speed^2 * energyCostFactor`. When energy drops below a threshold, hunger rises.

### Senses payload

Each request includes shared world context plus per-ant senses. Smells are projected to a point near the ant in the direction of the strongest gradient; the ant does not know the true source location.

```json
{
  "world": {
    "width": 600,
    "height": 400,
    "nest_x": 120,
    "nest_y": 200
  },
  "ants": [
    {
      "ant_id": "ant-0",
      "internal_state": {
        "carrying_food": false,
        "last_action": "moved_east",
        "energy": 80,
        "hunger": 10,
        "locked": false,
        "heading": 0.12
      },
      "position": { "x": 120.0, "y": 200.0 },
      "passive_senses": {
        "current_tile_chemicals": {
          "raid_trail": 0.9,
          "mandibular_alarm": 0.0,
          "bivouac_scent": 0.3,
          "toxin_scent": 0.0,
          "prey_scent": 0.1
        },
        "smell_points": {
          "raid_trail": { "x": 145.0, "y": 205.0, "strength": 0.9 },
          "prey_scent": { "x": 125.0, "y": 220.0, "strength": 0.1 }
        },
        "nearest_food": { "x": 300.0, "y": 180.0, "distance": 185.0 }
      },
      "tactile_memory": {
        "last_antenna_sweep_East": "sister_ant_moving_East",
        "last_antenna_sweep_NorthEast": "empty"
      }
    }
  ]
}
```

The `world` block gives every ant the same home coordinate (`nest_x`, `nest_y`) and boundaries. Carrying-food ants should target the nest. Smell points and nearest food are given as coordinates the ant can walk toward. Antenna sweeps provide directed tactile checks.

### Decision contract

The LLM returns one target coordinate per ant:

```json
{
  "decisions": [
    {
      "ant_id": "ant-0",
      "target": { "x": 120.0, "y": 200.0 },
      "speed": 5
    }
  ]
}
```

- `target(x, y)` — the ant's primary goal. The engine turns the ant gradually toward this coordinate while keeping it moving forward.
- `speed` — optional override for the ant's walking speed.

Automatic behaviors (not controlled by the LLM):
- Food is picked up automatically when an ant touches it.
- Food is dropped automatically at the nest.
- Hazards damage the ant and set `in_toxic_area`; the renderer blinks the ant red.
- Gaps push ants back to the nearest edge.

---

## 3. High-level architecture

### Phase 1: browser-only engine

```
Browser
  ├── Vite dev server serves index.html
  ├── main.ts runs the simulation loop
  │     ├── Engine (World, Ant, ChemicalLayer, DiffusionSolver)
  │     └── Renderer (Canvas 2D, SVG ant sprites)
  └── No LLM yet; ants use dumb/random/heuristic controllers
```

### Phase 3+: client-server split

```
Server (Node.js)
  ├── World state manager
  ├── Tick loop
  ├── LLM orchestrator
  └── WebSocket pushes world diffs

Browser client
  ├── Canvas renderer
  ├── WebSocket receiver
  └── UI controls
```

---

## 4. Phased implementation plan

### Phase 1: Browser engine and renderer

Goal: a deterministic continuous-world simulation with 300 ants, chemical diffusion, and smooth Canvas rendering.

- Set up Vite + TypeScript project.
- Build `ChemicalLayer` with bilinear deposit and separable diffusion.
- Build `Ant` with position, heading, speed, energy, hunger.
- Build `World` with walls, hazards, food, and 300 ants.
- Build `Renderer` that draws chemical heatmaps and SVG ants.
- Add a simple controller: ants wander, deposit raid trail, bounce off walls, and lose energy.

Success criteria: open the browser, see 300 ants moving smoothly over a diffusing pheromone field.

### Phase 2: Tool contract and mock LLM

Goal: prove the LLM interface without API calls.

- Move the engine to a Node.js server.
- Add WebSocket sync to the frontend.
- Define Zod schemas for tool calls.
- Create a mock orchestrator that returns scripted tool calls.
- Implement `set_heading`, `set_speed`, `sweep_antenna`, `bite`, and `lock_legs`.
- Add collision and action ordering.

Success criteria: ants respond to scripted tool calls over WebSocket; walls and collisions block movement.

### Phase 3: Real LLM integration

Goal: one ant, one real API call per tick, then scale to the swarm.

- Replace the mock orchestrator with live OpenAI-compatible API calls.
- Add exponential back-off, timeouts, and request logging.
- Cache system prompts; only per-tick state changes between calls.
- Batch ant payloads into parallel requests.
- Measure latency at 1, 10, 50, 100, 300 ants.

Success criteria: ants navigate using smell gradients and antenna sweeps; tick rate stays stable.

### Phase 4: Emergent army-ant behaviors

Goal: make the swarm behave like real army ants.

- Tune raid-trail reinforcement so trails form and polarize.
- Add prey scent, biting, and food carrying.
- Add mandibular alarm pheromone during attacks.
- Add bivouac scent so ants can find the nest.
- Add `lock_legs` bridge behavior over gaps and hazards.

Success criteria: ants form trails, recruit to prey, carry food home, and bridge gaps without explicit global coordination.

### Phase 5: Scale to 3000 × 2000

Goal: hit the target grid resolution.

- Profile diffusion at 600 × 400 and 1200 × 800.
- Swap the CPU solver for a WebGPU compute shader.
- Optimize network sync: send compressed chemical images and delta-encoded ant positions.
- Add replay and trace inspection.

Success criteria: 300 ants run at a stable tick rate on a 3000 × 2000 chemical grid.

---

## 5. Biggest risks and mitigations

### Grid diffusion at high resolution

A 3000 × 2000 grid with five layers is 120 MB of state. CPU convolution is too slow for real-time.

Mitigations:
- Start at 600 × 400.
- Use separable convolution.
- Move diffusion to a WebGPU compute shader for the target resolution.
- Run diffusion on a fixed interval if the tick rate exceeds what the GPU can sustain.

### API latency at 300 ants

Even cheap API calls add up. 300 parallel requests can overwhelm rate limits or create queueing delays.

Mitigations:
- Batch payloads into the largest request the provider allows.
- Add a request queue with concurrency limits.
- Let ants with pending responses repeat their last safe action or coast.
- Use a fallback heuristic controller for ants in uneventful regions.

### Network bandwidth for chemical layers

Sending five full Float32 grids every tick is multiple megabytes.

Mitigations:
- Send chemicals as compressed images, not raw arrays.
- Update chemical visuals at a lower frequency than ant positions.
- Downsample chemical layers for display while simulating at full resolution.

### Ants getting stuck

Blind agents can oscillate or crowd.

Mitigations:
- Include `last_action` in every payload.
- Add small random jitter to heading decisions.
- Use tactile memory of recent traffic direction.

---

## 6. First file layout

```
ant-simulation/
  package.json
  tsconfig.json
  vite.config.ts
  index.html
  public/
    ant.svg
  src/
    main.ts
    engine/
      types.ts
      World.ts
      Ant.ts
      ChemicalLayer.ts
      DiffusionSolver.ts
      controllers/
        WanderController.ts
    client/
      Renderer.ts
```

---

## 7. Next step

Start Phase 1. Scaffold the Vite project, implement `ChemicalLayer` and `DiffusionSolver`, create an SVG ant sprite, and render 300 wandering ants on a diffusing pheromone field.
