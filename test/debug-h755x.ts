// Diagnostic: dump solution groups for h755x/ecat_more_complex
import { JSDOM } from 'jsdom';
(globalThis as any).DOMParser = new JSDOM().window.DOMParser;

import { parseMcuXml } from '../src/parser/mcu-xml-parser';
import { parseConstraints } from '../src/parser/constraint-parser';
import { solvePriorityBacktracking } from '../src/solver/priority-backtracking-solver';
import { solvePriorityGroup } from '../src/solver/priority-group-solver';
import { solveMrvGroup } from '../src/solver/mrv-group-solver';
import { readFileSync } from 'fs';
import type { Solution } from '../src/types';

const mcuXml = readFileSync('test/h755x/STM32H745XIHx.xml', 'utf-8');
const mcu = parseMcuXml(mcuXml);
const constraintText = readFileSync('test/h755x/pass/ecat_more_complex.txt', 'utf-8');
const { ast } = parseConstraints(constraintText);

const costWeights = new Map<string, number>([
  ['pin_count', 1], ['port_spread', 0.2], ['peripheral_count', 0.5],
  ['debug_pin_penalty', 0], ['pin_clustering', 0], ['pin_proximity', 1],
]);

function dumpGroups(label: string, solutions: Solution[]) {
  // Extract unique peripheral fingerprints
  const groups = new Map<string, { count: number; cost: number; sample: Solution }>();
  for (const sol of solutions) {
    const parts: string[] = [];
    for (const [portName, peripherals] of sol.portPeripherals) {
      const instances = [...peripherals].sort();
      parts.push(`${portName}=[${instances.join(',')}]`);
    }
    parts.sort();
    const fp = parts.join(' | ');
    const existing = groups.get(fp);
    if (!existing || sol.totalCost < existing.cost) {
      groups.set(fp, { count: (existing?.count ?? 0) + 1, cost: sol.totalCost, sample: sol });
    } else {
      existing.count++;
    }
  }

  console.log(`\n=== ${label}: ${solutions.length} solutions, ${groups.size} groups ===`);
  let i = 0;
  for (const [fp, { count, cost, sample }] of [...groups.entries()].sort((a, b) => a[1].cost - b[1].cost)) {
    console.log(`  Group ${++i} (${count} solutions, cost=${cost.toFixed(1)}):`);
    // Show configs
    for (const cca of sample.configAssignments) {
      const activeStr = [...cca.activeConfigs.entries()].map(([k,v]) => `${k}=${v}`).sort().join(', ');
      console.log(`    configs: ${activeStr}`);
      if (i === 1) {
        // Dump first group's pin assignments
        console.log('    --- Sample pin assignments (ENC+ECAT only): ---');
        for (const a of cca.assignments) {
          if (a.portName.startsWith('ENC') || a.portName.startsWith('ECAT')) {
            console.log(`      ${a.portName}.${a.channelName} = ${a.pinName} (${a.signalName})`);
          }
        }
      }
    }
    for (const part of fp.split(' | ')) {
      console.log(`    ${part}`);
    }
  }
}

console.log('--- priority-backtracking (single-phase) ---');
const r1 = solvePriorityBacktracking(ast!, mcu, {
  maxSolutions: 5000, timeoutMs: 10000, costWeights, skipGpioMapping: true,
});
console.log(`Errors: ${r1.errors.map(e => e.message).join('; ')}`);
dumpGroups('priority-backtracking', r1.solutions);

// Dump Phase 1 groups from two-phase solver
import { expandAllMacros } from '../src/parser/macro-expander';
import { getStdlibMacros } from '../src/parser/stdlib-macros';
import {
  extractPorts, resolveReservePatterns, extractPinnedAssignments,
  extractSharedPatterns, resolveAllVariables,
  generateConfigCombinations, partitionGpioVariables, isGpioVariable,
  configsHaveDma,
} from '../src/solver/solver';
import {
  buildInstanceVariables, solvePhase1, solvePhase2ForGroup,
  groupFingerprint, sortInstanceDomainsByCost,
  type InstanceGroup, type InstanceTracker,
} from '../src/solver/two-phase-solver';
import type { RequireNode } from '../src/parser/constraint-ast';

{
  console.log('\n--- Phase 1 diagnostic (two-phase internals) ---');
  const { ast: expandedAst } = expandAllMacros(ast!, getStdlibMacros());
  const ports = extractPorts(expandedAst);
  const reserved = resolveReservePatterns(expandedAst, mcu);
  const pinnedAssignments = extractPinnedAssignments(expandedAst);
  const sharedPatterns = extractSharedPatterns(expandedAst);
  const reservedPinSet = new Set(reserved.pins);
  for (const pa of pinnedAssignments) reservedPinSet.add(pa.pinName);
  const reservedPeripheralSet = new Set(reserved.peripherals);
  const configCombinations = generateConfigCombinations(ports);
  const dmaData = mcu.dma && configsHaveDma(ports) ? mcu.dma : undefined;
  const allVariables = resolveAllVariables(ports, mcu, reservedPinSet, reservedPeripheralSet);
  const { solveVars } = partitionGpioVariables(allVariables, true);
  const nonGpioVars = solveVars.filter(v => !isGpioVariable(v));
  const allInstanceVars = buildInstanceVariables(nonGpioVars);
  sortInstanceDomainsByCost(allInstanceVars, costWeights);

  console.log(`Config combinations: ${configCombinations.length}`);
  for (const combo of configCombinations) {
    console.log(`  ${[...combo.entries()].map(([k, v]) => `${k}=${v}`).join(', ')}`);
  }

  console.log(`\nInstance variables (${allInstanceVars.length}):`);
  for (const iv of allInstanceVars) {
    console.log(`  ${iv.portName}.${iv.channelName} (config=${iv.configName}): domain=[${iv.domain.join(',')}]`);
  }

  // Run Phase 1 for first config combo
  const combo = configCombinations[0];
  const activeVars = allInstanceVars.filter(iv => combo.get(iv.portName) === iv.configName);
  console.log(`\nActive vars for combo 0 (${[...combo.entries()].map(([k,v])=>`${k}=${v}`).join(',')}): ${activeVars.length}`);
  for (const iv of activeVars) {
    console.log(`  ${iv.portName}.${iv.channelName}: domain=[${iv.domain.join(',')}]`);
  }

  // Run Phase 1
  const configRequiresMap = new Map<string, RequireNode[]>();
  for (const [portName, port] of ports) {
    for (const c of port.configs) {
      if (c.requires.length > 0)
        configRequiresMap.set(`${portName}\0${c.name}`, c.requires);
    }
  }

  activeVars.sort((a, b) => a.domain.length - b.domain.length);
  const lastVarOfConfig = new Map<string, number>();
  for (let i = 0; i < activeVars.length; i++) {
    lastVarOfConfig.set(`${activeVars[i].portName}\0${activeVars[i].configName}`, i);
  }

  const tracker: InstanceTracker = {
    instanceOwner: new Map(),
    instanceRefCount: new Map(),
    sharedPatterns,
  };

  const groups: InstanceGroup[] = [];
  solvePhase1(activeVars, 0, tracker, [], ports, groups, 20, performance.now(), 10000, lastVarOfConfig, configRequiresMap, dmaData);
  console.log(`\nPhase 1 found ${groups.length} groups for combo 0:`);
  for (let i = 0; i < Math.min(groups.length, 10); i++) {
    const g = groups[i];
    const assigns = [...g.assignments.entries()].sort().map(([k, v]) => `${k}=${v}`).join(', ');
    console.log(`  Group ${i}: ${assigns}`);
  }

  // Try Phase 2 on first few groups
  if (groups.length > 0) {
    console.log('\n--- Phase 2 attempts on first 5 groups ---');
    for (let i = 0; i < Math.min(groups.length, 5); i++) {
      const stats = { totalCombinations: 0, evaluatedCombinations: 0, validSolutions: 0, solveTimeMs: 0, configCombinations: 0 };
      const sols = solvePhase2ForGroup(
        groups[i], solveVars, ports, reserved.pins, pinnedAssignments,
        sharedPatterns, configCombinations, 5, performance.now(), 5000, stats,
        undefined, dmaData, new Map(), mcu, costWeights
      );
      console.log(`  Group ${i}: ${sols.length} Phase 2 solutions (stats: evaluated=${stats.evaluatedCombinations})`);
      if (sols.length === 0) {
        // Check which variables have empty domains after filtering
        const g = groups[i];
        const assigns = [...g.assignments.entries()].sort().map(([k, v]) => `${k}=${v}`).join(', ');
        console.log(`    Assignments: ${assigns}`);
      }
    }
  }
}
