import type { Mcu, Assignment, SolverResult } from '../types';

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
