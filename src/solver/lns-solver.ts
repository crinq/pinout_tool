// ============================================================
// LNS Repair Solver (Large Neighborhood Search)
//
// Works on COMPLETE assignments instead of building partial ones:
//
//   greedy construction (conflicts allowed)
//     → min-conflicts repair with tabu + noise
//     → stagnation: destroy the most-conflicted ports, re-repair
//     → feasible: verify + emit, then ban the incumbent instance of
//       a port and repair again — the destroy operator doubles as a
//       structural-diversity engine
//
// Never pays the deep-backtrack cost that kills DFS on very hard
// instances; anytime by construction. Incomplete: cannot prove
// infeasibility — pair with conflict-directed / cegar in a portfolio.
//
// Move-level conflict model: pin/physical/channel/signal collisions +
// instance exclusivity + same-port require constraints. Leaf-only
// constraints (DMA, cross-port requires) are enforced at emission via
// evaluateAllConstraints — a candidate emission that fails there
// triggers a targeted destroy instead of an invalid solution.
// ============================================================

import type { Mcu, Solution, SolverResult } from '../types';
import type { ProgramNode } from '../parser/constraint-ast';
import {
  prepareSolverContext, evaluateAllConstraints, buildSolution,
  evaluateExpr, isOptionalRequireVacuous, isSharedInstance,
  mergeSolverConfig, emptyResult, pushSolverWarnings, finalizeSolutions, solutionDedupKey,
  type SolverConfig, type VariableAssignment, type SolverContext,
} from './solver';
import { mulberry32 } from './solver-utils';

const NOISE_P = 0.1;             // random-walk probability
const TABU_TTL = 8;              // moves a reverted (var, value) stays tabu
const STAGNATION_MOVES = 400;    // moves without improvement before destroy
const RESTART_STAGNATIONS = 4;   // destroys without improvement before full restart
const BAN_TTL_MOVES = 2000;      // instance-ban duration in diversity mode
const BAN_PENALTY = 1000;
const EMISSION_FAIL_LIMIT = 25;  // consecutive verify-failures before restart

export function solveLnsRepair(
  ast: ProgramNode,
  mcu: Mcu,
  config: Partial<SolverConfig> = {}
): SolverResult {
  const cfg = mergeSolverConfig(config);
  const startTime = performance.now();
  const errors: import('../types').SolverError[] = [];

  const ctx = prepareSolverContext(ast, mcu, errors, cfg.skipGpioMapping);
  if (!ctx) return emptyResult(mcu.refName, errors);

  const solutions: Solution[] = [];
  runLns(ctx, cfg, solutions, startTime);

  pushSolverWarnings(errors, solutions, cfg.maxSolutions, startTime, cfg.timeoutMs);
  if (solutions.length === 0) {
    errors.push({
      type: 'error',
      message: 'LNS: no conflict-free assignment reached within the time budget (repair search is incomplete — try conflict-directed or cegar)',
    });
  }
  return finalizeSolutions(
    solutions, mcu, cfg.costWeights, errors, ctx.stats, startTime,
    ctx.gpioCountPerConfig, ctx.reservedPins, ctx.pinnedAssignments,
  );
}

function runLns(
  ctx: SolverContext,
  cfg: SolverConfig,
  solutions: Solution[],
  startTime: number,
): void {
  const variables = ctx.variables;
  const n = variables.length;
  const rng = mulberry32(0x1A2B3C4D);
  const deadline = () => performance.now() - startTime > cfg.timeoutMs;

  // ---------- occupancy (conflict-tolerant mirror of PinTracker rules) ----------
  const assignment = new Int32Array(n).fill(-1);
  const pinUse = new Map<string, Set<number>>();   // logical pin -> varIdxs
  const physUse = new Map<string, Set<number>>();  // physical position -> varIdxs
  const instUse = new Map<string, Set<number>>();  // peripheral instance -> varIdxs

  const use = (m: Map<string, Set<number>>, k: string, vi: number) => {
    if (!m.has(k)) m.set(k, new Set());
    m.get(k)!.add(vi);
  };
  const unuse = (m: Map<string, Set<number>>, k: string, vi: number) => {
    const s = m.get(k);
    if (s) { s.delete(vi); if (s.size === 0) m.delete(k); }
  };

  const place = (vi: number, candIdx: number): void => {
    assignment[vi] = candIdx;
    const c = variables[vi].candidates[candIdx];
    use(pinUse, c.pin.name, vi);
    if (c.pin.physical.position) use(physUse, c.pin.physical.position, vi);
    if (c.peripheralInstance) use(instUse, c.peripheralInstance, vi);
  };
  const remove = (vi: number): void => {
    const candIdx = assignment[vi];
    if (candIdx < 0) return;
    const c = variables[vi].candidates[candIdx];
    assignment[vi] = -1;
    unuse(pinUse, c.pin.name, vi);
    if (c.pin.physical.position) unuse(physUse, c.pin.physical.position, vi);
    if (c.peripheralInstance) unuse(instUse, c.peripheralInstance, vi);
  };

  // Reserved pins act like an immovable foreign port
  const reservedPins = new Set(ctx.reservedPins);

  /** Would candidates of vi and vj collide? (pin/phys/channel/signal/instance rules) */
  const pairConflict = (vi: number, ci: number, vj: number): boolean => {
    const a = variables[vi], b = variables[vj];
    const ca = a.candidates[ci], cb = b.candidates[assignment[vj]];
    const samePort = a.portName === b.portName;
    const sameConfig = samePort && a.configName === b.configName;

    if (ca.pin.name === cb.pin.name) {
      if (!samePort) return true;
      if (a.channelName !== b.channelName) return true;      // one channel per pin within a port
      if (sameConfig) return true;                            // pin once per (port, config)
      return false;                                           // same channel, other config: legal reuse
    }
    const pa = ca.pin.physical.position, pb = cb.pin.physical.position;
    if (pa && pa === pb) {
      if (!samePort) return true;                             // shared-pad siblings across ports
      if (a.channelName !== b.channelName) return true;
      if (sameConfig) return true;
      return false;
    }
    if (
      ca.peripheralInstance && ca.peripheralInstance === cb.peripheralInstance &&
      !samePort && !isSharedInstance(ca.peripheralInstance, ctx.sharedPatterns)
    ) return true;
    if (
      sameConfig && vi !== vj &&
      ca.signalName && ca.signalName === cb.signalName && ca.signalName.includes('_')
    ) return true;
    return false;
  };

  /** Pairwise conflicts a candidate would have against the current assignment. */
  const candidateConflicts = (vi: number, ci: number): number => {
    const c = variables[vi].candidates[ci];
    let count = 0;
    const seen = new Set<number>();
    const scan = (s: Set<number> | undefined) => {
      if (!s) return;
      for (const vj of s) {
        if (vj === vi || seen.has(vj)) continue;
        seen.add(vj);
        if (pairConflict(vi, ci, vj)) count++;
      }
    };
    scan(pinUse.get(c.pin.name));
    if (c.pin.physical.position) scan(physUse.get(c.pin.physical.position));
    if (c.peripheralInstance) scan(instUse.get(c.peripheralInstance));
    if (reservedPins.has(c.pin.name)) count += 10; // never acceptable
    return count;
  };

  // ---------- same-port require evaluation (move-level) ----------
  const configVarIndices = new Map<string, number[]>();
  for (let i = 0; i < n; i++) {
    const key = `${variables[i].portName}\0${variables[i].configName}`;
    if (!configVarIndices.has(key)) configVarIndices.set(key, []);
    configVarIndices.get(key)!.push(i);
  }

  const configViolations = (configKey: string): number => {
    const requires = ctx.configRequiresMap.get(configKey);
    if (!requires) return 0;
    const portName = configKey.split('\0')[0];
    const portChannels = new Map<string, VariableAssignment[]>();
    for (const vi of configVarIndices.get(configKey) ?? []) {
      if (assignment[vi] < 0) continue;
      const v = variables[vi];
      if (!portChannels.has(v.channelName)) portChannels.set(v.channelName, []);
      portChannels.get(v.channelName)!.push({ variable: v, candidate: v.candidates[assignment[vi]] });
    }
    const channelInfo = new Map<string, Map<string, VariableAssignment[]>>();
    channelInfo.set(portName, portChannels);
    let violations = 0;
    for (const req of requires) {
      if (req.optional) continue;
      if (isOptionalRequireVacuous(req.expression, portName, channelInfo)) continue;
      if (!evaluateExpr(req.expression, portName, channelInfo, ctx.dmaData, ctx.mcuInfo)) violations++;
    }
    return violations;
  };

  // Config-violation cache: recomputing every config's requires each move is
  // the bottleneck — only configs whose assignment changed are re-evaluated.
  const violationCache = new Map<string, number>();
  const invalidateConfig = (vi: number): void => {
    violationCache.delete(`${variables[vi].portName}\0${variables[vi].configName}`);
  };
  const cachedConfigViolations = (configKey: string): number => {
    let v = violationCache.get(configKey);
    if (v === undefined) {
      v = configViolations(configKey);
      violationCache.set(configKey, v);
    }
    return v;
  };

  // ---------- search state ----------
  const banUntil = new Map<string, number>();  // "port\0instance" -> move index
  const tabuUntil = new Map<number, number>(); // vi * 10000 + candIdx -> move index (approx key)
  const emittedKeys = new Set<string>();
  let moveIdx = 0;

  const tabuKey = (vi: number, ci: number) => vi * 100003 + ci;

  const scoreCandidate = (vi: number, ci: number): number => {
    const v = variables[vi];
    const c = v.candidates[ci];
    let score = candidateConflicts(vi, ci) * 10;
    if (c.peripheralInstance) {
      const ban = banUntil.get(`${v.portName}\0${c.peripheralInstance}`);
      if (ban !== undefined && ban > moveIdx) score += BAN_PENALTY;
    }
    return score;
  };

  /** Assign vi to its best candidate (greedy w/ noise + tabu + require check). */
  const repairVar = (vi: number): void => {
    const v = variables[vi];
    remove(vi);
    if (v.domain.length === 0) return; // optional with empty domain stays unassigned

    let bestCi = -1;
    let bestScore = Infinity;
    if (rng() < NOISE_P) {
      bestCi = v.domain[Math.floor(rng() * v.domain.length)];
    } else {
      const configKey = `${v.portName}\0${v.configName}`;
      for (const ci of v.domain) {
        const t = tabuUntil.get(tabuKey(vi, ci));
        if (t !== undefined && t > moveIdx) continue;
        let s = scoreCandidate(vi, ci);
        if (s < bestScore) {
          // Require delta only for currently-best candidates (evaluation is the pricey part)
          place(vi, ci);
          s += configViolations(configKey) * 10;
          remove(vi);
          if (s < bestScore) { bestScore = s; bestCi = ci; }
        }
        if (bestScore === 0) break;
      }
      if (bestCi === -1) bestCi = v.domain[Math.floor(rng() * v.domain.length)];
    }
    place(vi, bestCi);
    invalidateConfig(vi);
    tabuUntil.set(tabuKey(vi, bestCi), moveIdx + TABU_TTL);
  };

  /** Greedy (re-)construction: most constrained first. */
  const construct = (): void => {
    violationCache.clear();
    for (let vi = 0; vi < n; vi++) remove(vi);
    const order = [...Array(n).keys()].sort((a, b) => variables[a].domain.length - variables[b].domain.length);
    for (const vi of order) {
      if (variables[vi].optional && variables[vi].domain.length === 0) continue;
      repairVar(vi);
    }
  };

  /** All vars in pairwise conflict or in a violated config. */
  const collectConflicted = (): number[] => {
    const conflicted = new Set<number>();
    for (let vi = 0; vi < n; vi++) {
      if (assignment[vi] < 0) {
        if (!variables[vi].optional) conflicted.add(vi);
        continue;
      }
      if (candidateConflicts(vi, assignment[vi]) > 0) conflicted.add(vi);
    }
    for (const [configKey, idxs] of configVarIndices) {
      if (cachedConfigViolations(configKey) > 0) {
        for (const vi of idxs) if (assignment[vi] >= 0 || !variables[vi].optional) conflicted.add(vi);
      }
    }
    return [...conflicted];
  };

  const destroyPorts = (portNames: string[]): void => {
    for (let vi = 0; vi < n; vi++) {
      if (portNames.includes(variables[vi].portName)) { remove(vi); invalidateConfig(vi); }
    }
    // repair destroyed vars most-constrained-first
    const destroyed = [...Array(n).keys()]
      .filter(vi => assignment[vi] < 0 && !(variables[vi].optional && variables[vi].domain.length === 0))
      .sort((a, b) => variables[a].domain.length - variables[b].domain.length);
    for (const vi of destroyed) repairVar(vi);
  };

  const portNames = [...new Set(variables.map(v => v.portName))];

  /** Ports ranked by current conflict participation. */
  const mostConflictedPorts = (k: number): string[] => {
    const counts = new Map<string, number>();
    for (const vi of collectConflicted()) {
      counts.set(variables[vi].portName, (counts.get(variables[vi].portName) ?? 0) + 1);
    }
    return [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, k).map(e => e[0]);
  };

  const buildCurrent = (): VariableAssignment[] => {
    const current: VariableAssignment[] = [];
    for (let vi = 0; vi < n; vi++) {
      if (assignment[vi] >= 0) {
        current.push({ variable: variables[vi], candidate: variables[vi].candidates[assignment[vi]] });
      }
    }
    return current;
  };

  // ---------- main loop ----------
  construct();
  let bestConflictCount = Infinity;
  let stagnation = 0;
  let stagnationRounds = 0;
  let emissionFails = 0;

  while (!deadline() && solutions.length < cfg.maxSolutions) {
    moveIdx++;
    const conflicted = collectConflicted();

    if (conflicted.length === 0) {
      // Candidate solution — verify leaf-only constraints (DMA, cross-port)
      const current = buildCurrent();
      ctx.stats.evaluatedCombinations++;
      const dmaOut: Map<string, string>[] = [];
      if (evaluateAllConstraints(current, ctx.configCombinations, ctx.ports, ctx.dmaData, dmaOut, ctx.mcuInfo, ctx.sharedPatterns)) {
        const sol = buildSolution(current, ctx.configCombinations, ctx.ports, ctx.pinnedAssignments, solutions.length, dmaOut);
        const key = solutionDedupKey(sol);
        if (!emittedKeys.has(key)) {
          emittedKeys.add(key);
          solutions.push(sol);
          ctx.stats.validSolutions++;
          const elapsed = performance.now() - startTime;
          if (ctx.stats.firstSolutionMs === undefined) ctx.stats.firstSolutionMs = elapsed;
          ctx.stats.lastSolutionMs = elapsed;
        }
        emissionFails = 0;
        // Diversity mode: ban the incumbent instance of a random multi-instance
        // port and rebuild it — forces a structurally different neighborhood.
        const port = portNames[Math.floor(rng() * portNames.length)];
        for (let vi = 0; vi < n; vi++) {
          if (variables[vi].portName !== port || assignment[vi] < 0) continue;
          const inst = variables[vi].candidates[assignment[vi]].peripheralInstance;
          if (inst) banUntil.set(`${port}\0${inst}`, moveIdx + BAN_TTL_MOVES);
        }
        const other = portNames[Math.floor(rng() * portNames.length)];
        destroyPorts(other === port ? [port] : [port, other]);
        bestConflictCount = Infinity;
        stagnation = 0;
        continue;
      }
      // Verified-invalid (DMA/cross-port): shake two random ports
      emissionFails++;
      if (emissionFails >= EMISSION_FAIL_LIMIT) {
        construct();
        emissionFails = 0;
      } else {
        const p1 = portNames[Math.floor(rng() * portNames.length)];
        const p2 = portNames[Math.floor(rng() * portNames.length)];
        destroyPorts(p1 === p2 ? [p1] : [p1, p2]);
      }
      bestConflictCount = Infinity;
      stagnation = 0;
      continue;
    }

    if (conflicted.length < bestConflictCount) {
      bestConflictCount = conflicted.length;
      stagnation = 0;
      stagnationRounds = 0;
    } else if (++stagnation >= STAGNATION_MOVES) {
      stagnation = 0;
      if (++stagnationRounds >= RESTART_STAGNATIONS) {
        construct(); // full restart (bans persist — keeps diversity pressure)
        stagnationRounds = 0;
        bestConflictCount = Infinity;
      } else {
        destroyPorts(mostConflictedPorts(2)); // large neighborhood move
      }
      continue;
    }

    // Min-conflicts move on a random conflicted variable
    const vi = conflicted[Math.floor(rng() * conflicted.length)];
    repairVar(vi);
  }
}
