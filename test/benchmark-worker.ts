// Worker script for running a single solver benchmark.
// Called via fork() from the benchmark test.
// Communicates via process.send/process.on('message').

// Polyfill DOMParser for Node.js (used by mcu-xml-parser)
import { JSDOM } from 'jsdom';
(globalThis as any).DOMParser = new JSDOM().window.DOMParser;

import { parseMcuXml } from '../src/parser/mcu-xml-parser';
import { parseDmaXml, isDmaXml } from '../src/parser/dma-xml-parser';
import { parseConstraints } from '../src/parser/constraint-parser';
import { solveConstraints } from '../src/solver/solver';
import { solveTwoPhase } from '../src/solver/two-phase-solver';
import { solveRandomizedRestarts } from '../src/solver/randomized-solver';
import { solveCostGuided } from '../src/solver/cost-guided-solver';
import { solveDiverseInstances } from '../src/solver/diverse-solver';
import { solveAC3 } from '../src/solver/ac3-solver';
import { solveDynamicMRV } from '../src/solver/dynamic-mrv-solver';
import { solvePriorityBacktracking } from '../src/solver/priority-backtracking-solver';
import { solvePriorityTwoPhase } from '../src/solver/priority-two-phase-solver';
import { solvePriorityDiverse } from '../src/solver/priority-diverse-solver';
import { solvePriorityGroup } from '../src/solver/priority-group-solver';
import { solveMrvGroup } from '../src/solver/mrv-group-solver';
import { solveRatioMrvGroup } from '../src/solver/ratio-mrv-group-solver';
import { readFileSync, readdirSync } from 'fs';
import { join, dirname } from 'path';
import type { SolverResult } from '../src/types';

interface WorkerInput {
  solverId: string;
  mcuFile: string;
  constraintFile: string;
  maxSolutions: number;
  timeoutMs: number;
  costWeights: [string, number][];
  twoPhaseConfig: { maxGroups: number; maxSolutionsPerGroup: number };
  numRestarts: number;
  skipGpioMapping?: boolean;
}

process.on('message', (input: WorkerInput) => {
  try {
    const costWeights = new Map(input.costWeights);
    const basicConfig = {
      maxSolutions: input.maxSolutions,
      timeoutMs: input.timeoutMs,
      costWeights,
      skipGpioMapping: input.skipGpioMapping,
    };
    const twoPhaseConfig = {
      maxGroups: input.twoPhaseConfig.maxGroups,
      maxSolutionsPerGroup: input.twoPhaseConfig.maxSolutionsPerGroup,
      timeoutMs: input.timeoutMs,
      costWeights,
      skipGpioMapping: input.skipGpioMapping,
    };

    const mcu = parseMcuXml(readFileSync(input.mcuFile, 'utf-8'));

    // Load DMA data if available
    const mcuDir = dirname(input.mcuFile);
    const dmaFiles = readdirSync(mcuDir).filter(f => f.startsWith('DMA-') && f.endsWith('.xml'));
    if (dmaFiles.length > 0) {
      const dmaPeripheral = mcu.peripherals.find(p => p.originalType === 'DMA');
      if (dmaPeripheral) {
        const matchingFile = dmaFiles.find(f => f.includes(dmaPeripheral.version));
        if (matchingFile) {
          const dmaXmlString = readFileSync(join(mcuDir, matchingFile), 'utf-8');
          if (isDmaXml(dmaXmlString)) {
            mcu.dma = parseDmaXml(dmaXmlString);
          }
        }
      }
    }

    const constraintText = readFileSync(input.constraintFile, 'utf-8');
    const { ast } = parseConstraints(constraintText);
    if (!ast) {
      process.send!({ error: `Failed to parse ${input.constraintFile}` });
      return;
    }

    let result: SolverResult;
    switch (input.solverId) {
      case 'backtracking':
        result = solveConstraints(ast, mcu, basicConfig);
        break;
      case 'two-phase':
        result = solveTwoPhase(ast, mcu, twoPhaseConfig);
        break;
      case 'randomized-restarts':
        result = solveRandomizedRestarts(ast, mcu, {
          numRestarts: input.numRestarts,
          maxSolutions: input.maxSolutions,
          timeoutMs: input.timeoutMs,
          costWeights,
          skipGpioMapping: input.skipGpioMapping,
        });
        break;
      case 'cost-guided':
        result = solveCostGuided(ast, mcu, basicConfig);
        break;
      case 'diverse-instances':
        result = solveDiverseInstances(ast, mcu, twoPhaseConfig);
        break;
      case 'ac3':
        result = solveAC3(ast, mcu, basicConfig);
        break;
      case 'dynamic-mrv':
        result = solveDynamicMRV(ast, mcu, basicConfig);
        break;
      case 'priority-backtracking':
        result = solvePriorityBacktracking(ast, mcu, basicConfig);
        break;
      case 'priority-two-phase':
        result = solvePriorityTwoPhase(ast, mcu, twoPhaseConfig);
        break;
      case 'priority-diverse':
        result = solvePriorityDiverse(ast, mcu, {
          numRestarts: input.numRestarts,
          maxSolutions: input.maxSolutions,
          timeoutMs: input.timeoutMs,
          costWeights,
          skipGpioMapping: input.skipGpioMapping,
        });
        break;
      case 'priority-group':
        result = solvePriorityGroup(ast, mcu, twoPhaseConfig);
        break;
      case 'mrv-group':
        result = solveMrvGroup(ast, mcu, twoPhaseConfig);
        break;
      case 'ratio-mrv-group':
        result = solveRatioMrvGroup(ast, mcu, twoPhaseConfig);
        break;
      default:
        result = solveConstraints(ast, mcu, basicConfig);
    }

    // Serialize — Maps aren't transferable over IPC
    const serializable = {
      solutions: result.solutions.map(s => ({
        totalCost: s.totalCost,
        portPeripherals: [...s.portPeripherals.entries()].map(([k, v]) => [k, [...v]]),
      })),
      errors: result.errors,
      statistics: result.statistics,
    };

    process.send!(serializable);
  } catch (err) {
    process.send!({ error: err instanceof Error ? err.message : String(err) });
  }
});
