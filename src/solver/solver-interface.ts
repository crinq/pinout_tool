export interface Solver {
  readonly id: string;
  readonly name: string;
  /** Short display label used when tagging per-solver errors/results. */
  readonly label: string;
  readonly description: string;
}
