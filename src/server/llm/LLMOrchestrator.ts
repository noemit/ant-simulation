import { buildAntPayload } from '../../engine/payload';
import type { Ant, AntTarget } from '../../engine/types';
import type { World } from '../../engine/World';
import type { LLMClient } from './LLMClient';
import type { AntDecisionInput } from './PromptBuilder';
import type { ParsedDecision } from './ResponseParser';

class Semaphore {
  private permits: number;
  private queue: (() => void)[] = [];

  constructor(permits: number) {
    this.permits = permits;
  }

  acquire(): Promise<void> {
    if (this.permits > 0) {
      this.permits--;
      return Promise.resolve();
    }
    return new Promise((resolve) => this.queue.push(resolve));
  }

  release(): void {
    const next = this.queue.shift();
    if (next) {
      next();
    } else {
      this.permits++;
    }
  }
}

export interface LLMOrchestratorMetrics {
  totalCalls: number;
  totalErrors: number;
  totalLatencyMs: number;
  lastTickLatencyMs: number;
  lastTickBatches: number;
}

export class LLMOrchestrator {
  private client: LLMClient;
  private batchSize: number;
  private semaphore: Semaphore;
  private fallback: (ant: Ant, world: World) => AntTarget;
  private batchTimeoutMs: number;
  private fillMissingWithFallback: boolean;
  private metrics: LLMOrchestratorMetrics = {
    totalCalls: 0,
    totalErrors: 0,
    totalLatencyMs: 0,
    lastTickLatencyMs: 0,
    lastTickBatches: 0,
  };

  constructor(
    client: LLMClient,
    batchSize: number,
    maxConcurrency: number,
    fallback: (ant: Ant, world: World) => AntTarget,
    batchTimeoutMs = 5000,
    fillMissingWithFallback = true
  ) {
    this.client = client;
    this.batchSize = batchSize;
    this.semaphore = new Semaphore(maxConcurrency);
    this.fallback = fallback;
    this.batchTimeoutMs = batchTimeoutMs;
    this.fillMissingWithFallback = fillMissingWithFallback;
  }

  getMetrics(): LLMOrchestratorMetrics {
    return { ...this.metrics };
  }

  setSystemPrompt(value: string): void {
    this.client.setSystemPrompt(value);
  }

  async decideAll(ants: Ant[], world: World): Promise<Map<string, AntTarget>> {
    const inputs: AntDecisionInput[] = ants.map((ant) => ({
      ant_id: ant.id,
      payload: buildAntPayload(ant, world),
    }));

    const batches: AntDecisionInput[][] = [];
    for (let i = 0; i < inputs.length; i += this.batchSize) {
      batches.push(inputs.slice(i, i + this.batchSize));
    }

    const start = performance.now();
    const results = await Promise.all(
      batches.map((batch) => this.runBatch(batch, world))
    );
    const elapsed = performance.now() - start;

    this.metrics.totalCalls += batches.length;
    this.metrics.totalLatencyMs += elapsed;
    this.metrics.lastTickLatencyMs = elapsed;
    this.metrics.lastTickBatches = batches.length;

    const decisions = new Map<string, AntTarget>();
    for (const result of results) {
      for (const decision of result) {
        decisions.set(decision.antId, decision.target);
      }
    }

    const uniqueTargets = new Set(Array.from(decisions.values()).map((t) => t.direction));
    console.log(
      `LLM decided ${decisions.size} ants, ${uniqueTargets.size} unique directions. ` +
        `Sample:`,
      Array.from(decisions.entries()).slice(0, 5).map(([id, t]) => ({ id, direction: t.direction }))
    );

    // Fill in any missing decisions with the fallback unless disabled.
    if (this.fillMissingWithFallback) {
      for (const ant of ants) {
        if (!decisions.has(ant.id)) {
          decisions.set(ant.id, this.fallback(ant, world));
        }
      }
    }

    return decisions;
  }

  private async runBatch(
    batch: AntDecisionInput[],
    world: World
  ): Promise<ParsedDecision[]> {
    await this.semaphore.acquire();
    try {
      return await this.raceBatch(batch);
    } catch (error) {
      this.metrics.totalErrors++;
      console.error(
        `LLM batch failed (${batch.length} ants):`,
        error instanceof Error ? error.message : error
      );
      // Fall back to individual ant reasoning so a failed LLM call doesn't
      // send every ant east (x+10) and cause U-turns.
      return batch.map((input) => {
        const ant = world.ants.find((a) => a.id === input.ant_id);
        return {
          antId: input.ant_id,
          target: ant ? this.fallback(ant, world) : { direction: 'forward left' },
        };
      });
    } finally {
      this.semaphore.release();
    }
  }

  private raceBatch(batch: AntDecisionInput[]): Promise<ParsedDecision[]> {
    return Promise.race([
      this.client.decideBatch(batch),
      new Promise<never>((_, reject) =>
        setTimeout(
          () => reject(new Error(`Batch timeout after ${this.batchTimeoutMs}ms`)),
          this.batchTimeoutMs
        )
      ),
    ]);
  }
}

export function createLLMOrchestrator(
  client: LLMClient,
  batchSize: number,
  maxConcurrency: number,
  fallback: (ant: Ant, world: World) => AntTarget,
  batchTimeoutMs?: number,
  fillMissingWithFallback?: boolean
): LLMOrchestrator {
  return new LLMOrchestrator(
    client,
    batchSize,
    maxConcurrency,
    fallback,
    batchTimeoutMs,
    fillMissingWithFallback
  );
}
