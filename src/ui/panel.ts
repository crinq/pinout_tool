import type { Mcu, Assignment, SolverResult, CompatibilityResult } from '../types';

// Re-export the generic Panel interface from ts_lib
export type { Panel } from '../../ts_lib/src/panel';

export type StateChangeType =
  | 'mcu-loaded'
  | 'solution-selected'
  | 'constraints-changed'
  | 'solver-complete'
  | 'theme-changed'
  | 'highlight-pins';

export interface StateChange {
  type: StateChangeType;
  mcu?: Mcu;
  assignments?: Assignment[];
  solverResult?: SolverResult;
  constraintText?: string;
  portColors?: Map<string, string>;
  /** Channel comments from constraint source: Map<"portName.channelName", comment> */
  channelComments?: Map<string, string>;
  gpioCount?: number;
  dmaStreamAssignment?: Map<string, string>;
  compatibility?: CompatibilityResult;
  /** Pin names to highlight in the package viewer (empty set clears) */
  highlightPins?: Set<string>;
  /** Color for the highlighted pins */
  highlightColor?: string;
}
