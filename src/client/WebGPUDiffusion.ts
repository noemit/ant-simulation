import type { Ant } from '../engine/types';

const GRID_WIDTH = 1500;
const GRID_HEIGHT = 1000;

const DIFFUSION_RATE = 0.15;
const EVAPORATION = 0.015;

const CHEMICAL_VERTICES = new Float32Array([
  -1, -1,
   1, -1,
  -1,  1,
   1,  1,
]);

const CHEMICAL_INDICES = new Uint16Array([0, 1, 2, 2, 1, 3]);

export class WebGPUDiffusion {
  readonly gridWidth = GRID_WIDTH;
  readonly gridHeight = GRID_HEIGHT;

  private device: GPUDevice | null = null;
  private canvas: HTMLCanvasElement | null = null;
  private context: GPUCanvasContext | null = null;

  // Ping-pong chemical textures.
  private texA: GPUTexture | null = null;
  private texB: GPUTexture | null = null;
  private depositTex: GPUTexture | null = null;

  private diffusePipeline: GPUComputePipeline | null = null;
  private diffuseBindGroupA: GPUBindGroup | null = null;
  private diffuseBindGroupB: GPUBindGroup | null = null;

  private depositPipeline: GPURenderPipeline | null = null;
  private depositBindGroup: GPUBindGroup | null = null;
  private indexBuffer: GPUBuffer | null = null;
  private vertexBuffer: GPUBuffer | null = null;
  private instanceBuffer: GPUBuffer | null = null;

  private renderPipeline: GPURenderPipeline | null = null;
  private renderSampler: GPUSampler | null = null;

  private paramsBuffer: GPUBuffer | null = null;
  private params = new Float32Array([GRID_WIDTH, GRID_HEIGHT, DIFFUSION_RATE, EVAPORATION]);

  private ready = false;
  private antCount = 0;

  async init(): Promise<boolean> {
    if (!navigator.gpu) return false;

    const adapter = await navigator.gpu.requestAdapter({
      powerPreference: 'high-performance',
    });
    if (!adapter) return false;

    this.device = await adapter.requestDevice();
    if (!this.device) return false;

    this.device.lost.then((info) => {
      console.error(`WebGPU device lost: ${info.reason}`, info.message);
      this.ready = false;
    });

    this.canvas = document.createElement('canvas');
    this.canvas.width = GRID_WIDTH;
    this.canvas.height = GRID_HEIGHT;
    this.context = this.canvas.getContext('webgpu');
    if (!this.context) return false;

    const canvasFormat = navigator.gpu.getPreferredCanvasFormat();
    this.context.configure({
      device: this.device,
      format: canvasFormat,
      alphaMode: 'premultiplied',
    });

    this.createTextures();
    this.createPipelines(canvasFormat);
    this.createBuffers();
    this.createBindGroups();
    this.clearTextures();

    this.ready = true;
    return true;
  }

  private createTextures(): void {
    if (!this.device) return;

    const desc: GPUTextureDescriptor = {
      size: [GRID_WIDTH, GRID_HEIGHT],
      format: 'rgba16float',
      usage:
        GPUTextureUsage.TEXTURE_BINDING |
        GPUTextureUsage.STORAGE_BINDING |
        GPUTextureUsage.RENDER_ATTACHMENT |
        GPUTextureUsage.COPY_DST,
    };

    this.texA = this.device.createTexture(desc);
    this.texB = this.device.createTexture(desc);
    this.depositTex = this.device.createTexture({
      size: [GRID_WIDTH, GRID_HEIGHT],
      format: 'rgba16float',
      usage:
        GPUTextureUsage.TEXTURE_BINDING |
        GPUTextureUsage.RENDER_ATTACHMENT |
        GPUTextureUsage.COPY_DST,
    });
  }

  private clearTextures(): void {
    if (!this.device || !this.texA || !this.texB) return;

    const encoder = this.device.createCommandEncoder();
    for (const tex of [this.texA, this.texB]) {
      const pass = encoder.beginRenderPass({
        colorAttachments: [
          {
            view: tex.createView(),
            loadOp: 'clear',
            clearValue: { r: 0, g: 0, b: 0, a: 0 },
            storeOp: 'store',
          },
        ],
      });
      pass.end();
    }
    this.device.queue.submit([encoder.finish()]);
  }

  /**
   * Zero out the chemical field. Call after the server restarts the world.
   */
  clear(): void {
    this.clearTextures();
  }

  private createPipelines(canvasFormat: GPUTextureFormat): void {
    if (!this.device) return;

    const diffuseModule = this.device.createShaderModule({
      code: `
        @group(0) @binding(0) var src: texture_2d<f32>;
        @group(0) @binding(1) var dst: texture_storage_2d<rgba16float, write>;
        @group(0) @binding(2) var deposit: texture_2d<f32>;
        @group(0) @binding(3) var<uniform> params: vec4<f32>;

        @compute @workgroup_size(16, 16)
        fn main(@builtin(global_invocation_id) id: vec3<u32>) {
          let size = vec2<i32>(i32(params.x), i32(params.y));
          let xy = vec2<i32>(id.xy);
          if (xy.x >= size.x || xy.y >= size.y) { return; }

          let c = textureLoad(src, xy, 0);
          let dep = textureLoad(deposit, xy, 0);

          let left = textureLoad(src, clamp(xy + vec2(-1, 0), vec2(0), size - 1), 0);
          let right = textureLoad(src, clamp(xy + vec2(1, 0), vec2(0), size - 1), 0);
          let up = textureLoad(src, clamp(xy + vec2(0, -1), vec2(0), size - 1), 0);
          let down = textureLoad(src, clamp(xy + vec2(0, 1), vec2(0), size - 1), 0);

          let d = params.z;
          let evap = params.w;
          let diffused = (left + right + up + down) * (d * 0.25) + c * (1.0 - d);
          let next = diffused * (1.0 - evap) + dep;

          textureStore(dst, xy, next);
        }
      `,
    });

    this.diffusePipeline = this.device.createComputePipeline({
      layout: 'auto',
      compute: { module: diffuseModule, entryPoint: 'main' },
    });

    const depositModule = this.device.createShaderModule({
      code: `
        struct Instance {
          @location(1) pos: vec2<f32>,
          @location(2) chem: vec4<f32>,
        };

        struct VOut {
          @builtin(position) pos: vec4<f32>,
          @location(0) chem: vec4<f32>,
          @location(1) uv: vec2<f32>,
        };

        @vertex
        fn vs(@location(0) v: vec2<f32>, inst: Instance) -> VOut {
          let size = vec2<f32>(25.0 / ${GRID_WIDTH}.0, 25.0 / ${GRID_HEIGHT}.0);
          let p = v * size + vec2<f32>(
            (inst.pos.x / ${GRID_WIDTH}.0) * 2.0 - 1.0,
            1.0 - (inst.pos.y / ${GRID_HEIGHT}.0) * 2.0
          );
          var out: VOut;
          out.pos = vec4(p, 0.0, 1.0);
          out.chem = inst.chem;
          out.uv = v;
          return out;
        }

        @fragment
        fn fs(in: VOut) -> @location(0) vec4<f32> {
          let r = length(in.uv);
          let alpha = smoothstep(1.0, 0.0, r);
          return in.chem * alpha;
        }
      `,
    });

    this.depositPipeline = this.device.createRenderPipeline({
      layout: 'auto',
      vertex: {
        module: depositModule,
        entryPoint: 'vs',
        buffers: [
          {
            arrayStride: 8,
            attributes: [{ shaderLocation: 0, offset: 0, format: 'float32x2' }],
          },
          {
            arrayStride: 24,
            stepMode: 'instance',
            attributes: [
              { shaderLocation: 1, offset: 0, format: 'float32x2' },
              { shaderLocation: 2, offset: 8, format: 'float32x4' },
            ],
          },
        ],
      },
      fragment: {
        module: depositModule,
        entryPoint: 'fs',
        targets: [
          {
            format: 'rgba16float',
            blend: {
              color: {
                operation: 'add',
                srcFactor: 'one',
                dstFactor: 'one',
              },
              alpha: {
                operation: 'add',
                srcFactor: 'one',
                dstFactor: 'one',
              },
            },
          },
        ],
      },
      primitive: { topology: 'triangle-list' },
    });

    const renderModule = this.device.createShaderModule({
      code: `
        @group(0) @binding(0) var chemTex: texture_2d<f32>;
        @group(0) @binding(1) var chemSampler: sampler;

        @vertex
        fn vs(@builtin(vertex_index) idx: u32) -> @builtin(position) vec4<f32> {
          var pos = array<vec2<f32>, 3>(
            vec2(-1.0, -1.0),
            vec2(3.0, -1.0),
            vec2(-1.0, 3.0)
          );
          return vec4(pos[idx], 0.0, 1.0);
        }

        @fragment
        fn fs(@builtin(position) pos: vec4<f32>) -> @location(0) vec4<f32> {
          let uv = pos.xy / vec2<f32>(${GRID_WIDTH}.0, ${GRID_HEIGHT}.0);
          let v = textureSample(chemTex, chemSampler, uv);

          let raid = v.r * 5.0;
          let alarm = v.g * 4.0;
          let foodTrail = v.b * 4.0;
          let prey = v.a * 5.0;

          let color =
            raid * vec3(1.0, 0.35, 0.12) +
            alarm * vec3(1.0, 0.12, 0.35) +
            foodTrail * vec3(0.15, 0.45, 1.0) +
            prey * vec3(1.0, 0.95, 0.25);

          return vec4(min(color, vec3(1.0)), 1.0);
        }
      `,
    });

    this.renderPipeline = this.device.createRenderPipeline({
      layout: 'auto',
      vertex: { module: renderModule, entryPoint: 'vs' },
      fragment: {
        module: renderModule,
        entryPoint: 'fs',
        targets: [{ format: canvasFormat }],
      },
      primitive: { topology: 'triangle-list' },
    });

    this.renderSampler = this.device.createSampler({
      magFilter: 'linear',
      minFilter: 'linear',
    });
  }

  private createBuffers(): void {
    if (!this.device) return;

    this.vertexBuffer = this.device.createBuffer({
      size: CHEMICAL_VERTICES.byteLength,
      usage: GPUBufferUsage.VERTEX,
      mappedAtCreation: true,
    });
    new Float32Array(this.vertexBuffer.getMappedRange()).set(CHEMICAL_VERTICES);
    this.vertexBuffer.unmap();

    this.indexBuffer = this.device.createBuffer({
      size: CHEMICAL_INDICES.byteLength,
      usage: GPUBufferUsage.INDEX,
      mappedAtCreation: true,
    });
    new Uint16Array(this.indexBuffer.getMappedRange()).set(CHEMICAL_INDICES);
    this.indexBuffer.unmap();

    // Start small; the buffer grows automatically in ensureInstanceBuffer().
    this.instanceBuffer = this.device.createBuffer({
      size: 24,
      usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
    });

    this.paramsBuffer = this.device.createBuffer({
      size: 16,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
    this.device.queue.writeBuffer(this.paramsBuffer, 0, this.params);
  }

  private ensureInstanceBuffer(minBytes: number): void {
    if (!this.device || !this.depositPipeline) return;
    if (this.instanceBuffer && this.instanceBuffer.size >= minBytes) return;

    this.instanceBuffer?.destroy();
    this.instanceBuffer = this.device.createBuffer({
      size: minBytes,
      usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
    });

    this.depositBindGroup = this.device.createBindGroup({
      layout: this.depositPipeline.getBindGroupLayout(0),
      entries: [{ binding: 0, resource: { buffer: this.instanceBuffer } }],
    });
  }

  private createBindGroups(): void {
    if (
      !this.device ||
      !this.texA ||
      !this.texB ||
      !this.depositTex ||
      !this.diffusePipeline ||
      !this.renderPipeline ||
      !this.renderSampler ||
      !this.paramsBuffer ||
      !this.instanceBuffer
    ) {
      return;
    }

    this.diffuseBindGroupA = this.device.createBindGroup({
      layout: this.diffusePipeline!.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: this.texA.createView() },
        { binding: 1, resource: this.texB.createView() },
        { binding: 2, resource: this.depositTex.createView() },
        { binding: 3, resource: { buffer: this.paramsBuffer } },
      ],
    });

    this.diffuseBindGroupB = this.device.createBindGroup({
      layout: this.diffusePipeline!.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: this.texB.createView() },
        { binding: 1, resource: this.texA.createView() },
        { binding: 2, resource: this.depositTex.createView() },
        { binding: 3, resource: { buffer: this.paramsBuffer } },
      ],
    });

    this.depositBindGroup = this.device.createBindGroup({
      layout: this.depositPipeline!.getBindGroupLayout(0),
      entries: [{ binding: 0, resource: { buffer: this.instanceBuffer! } }],
    });

    this.renderBindGroupA = this.device.createBindGroup({
      layout: this.renderPipeline!.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: this.texA.createView() },
        { binding: 1, resource: this.renderSampler },
      ],
    });

    this.renderBindGroupB = this.device.createBindGroup({
      layout: this.renderPipeline!.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: this.texB.createView() },
        { binding: 1, resource: this.renderSampler },
      ],
    });
  }

  private renderBindGroupA: GPUBindGroup | null = null;
  private renderBindGroupB: GPUBindGroup | null = null;
  // false = first diffuse writes to texB, so render from texB initially.
  private renderFromTexA = false;

  isReady(): boolean {
    return this.ready;
  }

  getCanvas(): HTMLCanvasElement | null {
    return this.canvas;
  }

  depositAnts(ants: Ant[], worldWidth: number, worldHeight: number): void {
    if (!this.device) return;

    const neededBytes = ants.length * 6 * Float32Array.BYTES_PER_ELEMENT;
    this.ensureInstanceBuffer(neededBytes);
    if (!this.instanceBuffer) return;

    const data = new Float32Array(ants.length * 6);
    let i = 0;
    for (const ant of ants) {
      const gx = (ant.x / worldWidth) * GRID_WIDTH;
      const gy = (ant.y / worldHeight) * GRID_HEIGHT;

      // Match server behavior: carriers lay a strong recruitment trail;
      // explorers lay a weak trail.
      const raid = ant.carryingFood ? 6.0 : 2.0;
      const alarm = 0.0;
      const foodTrail = ant.carryingFood ? 1.0 : 0.0;
      const prey = 0.0; // prey scent is environmental, emitted by food sources

      data[i++] = gx;
      data[i++] = gy;
      data[i++] = raid;
      data[i++] = alarm;
      data[i++] = foodTrail;
      data[i++] = prey;
    }

    this.antCount = ants.length;
    this.device.queue.writeBuffer(
      this.instanceBuffer,
      0,
      data,
      0,
      i * Float32Array.BYTES_PER_ELEMENT
    );
  }

  step(): void {
    if (!this.ready || !this.device || !this.context) return;

    const encoder = this.device.createCommandEncoder();

    // 1. Render deposits into depositTex (cleared to zero first).
    if (this.depositPipeline && this.depositBindGroup) {
      const pass = encoder.beginRenderPass({
        colorAttachments: [
          {
            view: this.depositTex!.createView(),
            loadOp: 'clear',
            clearValue: { r: 0, g: 0, b: 0, a: 0 },
            storeOp: 'store',
          },
        ],
      });
      pass.setPipeline(this.depositPipeline);
      pass.setVertexBuffer(0, this.vertexBuffer!);
      pass.setVertexBuffer(1, this.instanceBuffer!);
      pass.setIndexBuffer(this.indexBuffer!, 'uint16');
      pass.setBindGroup(0, this.depositBindGroup);
      pass.drawIndexed(6, this.antCount, 0, 0, 0);
      pass.end();
    }

    // 2. Diffuse: texA + deposit -> texB, then swap.
    if (this.diffusePipeline && this.diffuseBindGroupA) {
      const pass = encoder.beginComputePass();
      pass.setPipeline(this.diffusePipeline);
      pass.setBindGroup(0, this.diffuseBindGroupA);
      pass.dispatchWorkgroups(
        Math.ceil(GRID_WIDTH / 16),
        Math.ceil(GRID_HEIGHT / 16)
      );
      pass.end();
    }

    // 3. Render the texture that just received the diffuse result.
    const renderBindGroup = this.renderFromTexA
      ? this.renderBindGroupA
      : this.renderBindGroupB;
    if (this.renderPipeline && renderBindGroup) {
      const canvasView = this.context.getCurrentTexture().createView();
      const pass = encoder.beginRenderPass({
        colorAttachments: [
          {
            view: canvasView,
            loadOp: 'clear',
            clearValue: { r: 0, g: 0, b: 0, a: 1 },
            storeOp: 'store',
          },
        ],
      });
      pass.setPipeline(this.renderPipeline);
      pass.setBindGroup(0, renderBindGroup);
      pass.draw(3);
      pass.end();
    }

    this.device.queue.submit([encoder.finish()]);

    // Swap bind groups so texA always holds the latest state.
    const tmp = this.diffuseBindGroupA;
    this.diffuseBindGroupA = this.diffuseBindGroupB;
    this.diffuseBindGroupB = tmp;
    this.renderFromTexA = !this.renderFromTexA;
  }

  destroy(): void {
    this.texA?.destroy();
    this.texB?.destroy();
    this.depositTex?.destroy();
    this.device?.destroy();
    this.ready = false;
  }
}
