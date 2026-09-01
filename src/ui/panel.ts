import type { Mcu, Assignment, Solution, SolverResult, CompatibilityResult } from '../types';
import type { DivergentPin } from '../solution-compare';

// Re-export the generic Panel interface from ts_lib
export type { Panel } from '../../ts_lib/src/panel';

export type StateChangeType =
  | 'mcu-loaded'
  | 'solution-selected'
  | 'compare-selected'
  | 'constraints-changed'
  | 'solver-complete'
  | 'theme-changed'
  | 'highlight-pins';

export type HighlightStyle = 'pulse' | 'subtle';

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
  /**
   * How to draw them. 'pulse' is the animated glow used by hover and search;
   * 'subtle' is a static thin ring, quiet enough to leave on screen while
   * working (the constraint editor's caret highlight). Defaults to 'pulse'.
   */
  highlightStyle?: HighlightStyle;
  /** Compare-mode payload */
  solutions?: Solution[];
  solutionColors?: string[];
  divergentByPin?: Map<string, DivergentPin>;
}
