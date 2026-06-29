import { ChemicalLayer } from './ChemicalLayer';

export class DiffusionSolver {
  step(layers: ChemicalLayer[]): void {
    for (const layer of layers) {
      layer.step();
    }
  }
}
