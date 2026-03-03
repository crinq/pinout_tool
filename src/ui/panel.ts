import type { Mcu, Assignment, SolverResult, CompatibilityResult } from '../types';

export type StateChangeType =
  | 'mcu-loaded'
  | 'solution-selected'
  | 'constraints-changed'
  | 'solver-complete'
  | 'theme-changed';

export interface StateChange {
  type: StateChangeType;
  mcu?: Mcu;
  assignments?: Assignment[];
  solverResult?: SolverResult;
  constraintText?: string;
  portColors?: Map<string, string>;
  gpioCount?: number;
  dmaStreamAssignment?: Map<string, string>;
  compatibility?: CompatibilityResult;
}

export interface Panel {
  readonly id: string;
  readonly title: string;

  createView(container: HTMLElement): void;
  onActivate?(): void;
  onDeactivate?(): void;
  onStateChange?(change: StateChange): void;
  destroy?(): void;
}
