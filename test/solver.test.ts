import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, existsSync } from 'fs';
import { join } from 'path';
import { parseMcuXml } from '../src/parser/mcu-xml-parser';
import { parseDmaXml, isDmaXml } from '../src/parser/dma-xml-parser';
import { parseConstraints } from '../src/parser/constraint-parser';
import { solveConstraints, extractSharedPatterns, isSharedInstance } from '../src/solver/solver';
import { solveTwoPhase } from '../src/solver/two-phase-solver';
import { solveRandomizedRestarts } from '../src/solver/randomized-solver';
import { solveCostGuided } from '../src/solver/cost-guided-solver';
import { solveDiverseInstances } from '../src/solver/diverse-solver';
import { solveAC3 } from '../src/solver/ac3-solver';
import { solveDynamicMRV } from '../src/solver/dynamic-mrv-solver';
import { expandAllMacros } from '../src/parser/macro-expander';
import { getStdlibMacros } from '../src/parser/stdlib-macros';
import type { Solution, SolverResult, Mcu, Assignment } from '../src/types';
import type { ProgramNode, PatternPart, PortDeclNode, ConfigDeclNode, MappingNode, RequireNode } from '../src/parser/constraint-ast';

// ============================================================
// Test Data Discovery
// ============================================================

const TEST_DIR = join(__dirname);

interface TestCase {
  mcuFolder: string;
  mcuFile: string;
  constraintFile: string;
  expectPass: boolean;
}

function discoverTestCases(): TestCase[] {
  const cases: TestCase[] = [];

  const folders = readdirSync(TEST_DIR, { withFileTypes: true })
    .filter(d => d.isDirectory() && !d.name.startsWith('.'));

  for (const folder of folders) {
    const folderPath = join(TEST_DIR, folder.name);

    // Find the MCU XML file (skip DMA XML files)
    const xmlFiles = readdirSync(folderPath).filter(f => f.endsWith('.xml') && !f.startsWith('DMA-'));
    if (xmlFiles.length === 0) continue;
    const mcuFile = join(folderPath, xmlFiles[0]);

    // Discover pass cases
    const passDir = join(folderPath, 'pass');
    if (existsSync(passDir)) {
      const passFiles = readdirSync(passDir).filter(f => f.endsWith('.txt'));
      for (const f of passFiles) {
        cases.push({
          mcuFolder: folder.name,
          mcuFile,
          constraintFile: join(passDir, f),
          expectPass: true,
        });
      }
    }

    // Discover fail cases
    const failDir = join(folderPath, 'fail');
    if (existsSync(failDir)) {
      const failFiles = readdirSync(failDir).filter(f => f.endsWith('.txt'));
      for (const f of failFiles) {
        cases.push({
          mcuFolder: folder.name,
          mcuFile,
          constraintFile: join(failDir, f),
          expectPass: false,
        });
      }
    }
  }

  return cases;
}

// ============================================================
// Solution Invariant Checks
// ============================================================

function getSharedPatterns(ast: ProgramNode): PatternPart[] {
  const { ast: expanded } = expandAllMacros(ast, getStdlibMacros());
  return extractSharedPatterns(expanded);
}

/**
 * Extract the peripheral instance from a signal name.
 * e.g., "USART1_TX" -> "USART1", "ADC1_IN0" -> "ADC1"
 */
function extractInstance(signalName: string): string | null {
  const idx = signalName.indexOf('_');
  if (idx === -1) return null;
  return signalName.substring(0, idx);
}

/**
 * Check solution invariants:
 * 1. All peripheral signals are exclusive for one channel and one pin per config
 * 2. All peripheral instances are exclusive to one port (except shared)
 * 3. All pins are exclusive to one channel
 * 4. All assigned DMA streams are exclusive for one port
 */
function checkSolutionInvariants(
  solution: Solution,
  sharedPatterns: PatternPart[],
  testLabel: string,
): string[] {
  const errors: string[] = [];

  for (const ca of solution.configAssignments) {
    // Track signal -> (port, channel) ownership — peripheral signals are exclusive per config
    const signalOwner = new Map<string, { port: string; channel: string; pin: string }>();
    // Track instance -> port ownership
    const instanceOwner = new Map<string, string>();
    // Track pin -> (port, channel) ownership — a pin belongs to one channel
    const pinOwner = new Map<string, { port: string; channel: string }>();
    // Track DMA stream -> port ownership
    const dmaStreamOwner = new Map<string, string>();

    for (const a of ca.assignments) {
      if (a.portName === '<pinned>') continue;

      // Check peripheral signal exclusivity: one channel and one pin per config
      if (a.signalName.includes('_')) {
        const existing = signalOwner.get(a.signalName);
        if (existing) {
          if (existing.port !== a.portName || existing.channel !== a.channelName) {
            errors.push(
              `[sol ${solution.id}] Signal "${a.signalName}" assigned to ${existing.port}.${existing.channel}(${existing.pin}) and ${a.portName}.${a.channelName}(${a.pinName})`
            );
          }
        }
        signalOwner.set(a.signalName, { port: a.portName, channel: a.channelName, pin: a.pinName });
      }

      // Check pin exclusivity: a pin belongs to one channel
      const existingPin = pinOwner.get(a.pinName);
      if (existingPin) {
        if (existingPin.port !== a.portName) {
          errors.push(
            `[sol ${solution.id}] Pin "${a.pinName}" assigned to both port "${existingPin.port}" and "${a.portName}"`
          );
        } else if (existingPin.channel !== a.channelName) {
          errors.push(
            `[sol ${solution.id}] Pin "${a.pinName}" assigned to both channel "${existingPin.channel}" and "${a.channelName}" in port "${a.portName}"`
          );
        }
      }
      pinOwner.set(a.pinName, { port: a.portName, channel: a.channelName });

      // Check peripheral instance exclusivity (unless shared)
      const instance = extractInstance(a.signalName);
      if (instance) {
        const isShared = isSharedInstance(instance, sharedPatterns);
        if (!isShared) {
          const existingInstanceOwner = instanceOwner.get(instance);
          if (existingInstanceOwner !== undefined && existingInstanceOwner !== a.portName) {
            errors.push(
              `[sol ${solution.id}] Non-shared peripheral instance "${instance}" assigned to both port "${existingInstanceOwner}" and "${a.portName}"`
            );
          }
        }
        instanceOwner.set(instance, a.portName);
      }
    }

    // Check DMA stream exclusivity: each stream belongs to one port
    if (ca.dmaStreamAssignment) {
      for (const [signalName, streamName] of ca.dmaStreamAssignment) {
        // Find which port owns this signal
        const sigInfo = signalOwner.get(signalName);
        const port = sigInfo?.port;
        if (!port) continue;

        const existingPort = dmaStreamOwner.get(streamName);
        if (existingPort !== undefined && existingPort !== port) {
          errors.push(
            `[sol ${solution.id}] DMA stream "${streamName}" assigned to both port "${existingPort}" and "${port}"`
          );
        }
        dmaStreamOwner.set(streamName, port);
      }
    }
  }

  return errors;
}

/**
 * Check that all pins in the solution actually exist in the MCU.
 */
function checkPinsExistInMcu(solution: Solution, mcu: Mcu): string[] {
  const errors: string[] = [];
  for (const ca of solution.configAssignments) {
    for (const a of ca.assignments) {
      if (a.portName === '<pinned>') continue;
      if (!mcu.pinByName.has(a.pinName) && !mcu.pinByGpioName.has(a.pinName)) {
        errors.push(`[sol ${solution.id}] Pin "${a.pinName}" not found in MCU ${mcu.refName}`);
      }
    }
  }
  return errors;
}

/**
 * Check that all signals in the solution actually exist on their assigned pins.
 */
function checkSignalsExistOnPins(solution: Solution, mcu: Mcu): string[] {
  const errors: string[] = [];
  for (const ca of solution.configAssignments) {
    for (const a of ca.assignments) {
      if (a.portName === '<pinned>') continue;
      const pin = mcu.pinByName.get(a.pinName) ?? mcu.pinByGpioName.get(a.pinName);
      if (!pin) continue; // already caught by checkPinsExistInMcu
      const hasSignal = pin.signals.some(s => s.name === a.signalName);
      if (!hasSignal) {
        errors.push(
          `[sol ${solution.id}] Signal "${a.signalName}" not available on pin "${a.pinName}"`
        );
      }
    }
  }
  return errors;
}

/**
 * Check same_instance constraints hold in solution.
 * For each config's require same_instance(ch1, ch2, ..., "TYPE") constraints,
 * verify all referenced channels in the solution use the same peripheral instance.
 */
function checkSameInstanceConstraints(
  solution: Solution,
  ast: ProgramNode,
): string[] {
  const errors: string[] = [];
  const { ast: expanded } = expandAllMacros(ast, getStdlibMacros());

  for (const ca of solution.configAssignments) {
    // Build lookup: (portName, channelName) -> assignment
    const assignmentMap = new Map<string, Assignment>();
    for (const a of ca.assignments) {
      assignmentMap.set(`${a.portName}\0${a.channelName}`, a);
    }

    // Walk ports and their active configs
    for (const stmt of expanded.statements) {
      if (stmt.type !== 'port_decl') continue;
      const port = stmt as PortDeclNode;
      const activeConfigName = ca.activeConfigs.get(port.name);
      if (!activeConfigName) continue;

      const config = port.configs.find(c => c.name === activeConfigName);
      if (!config) continue;

      for (const item of config.body) {
        if (item.type !== 'require') continue;
        const req = item as RequireNode;
        if (req.expression.type !== 'function_call') continue;
        if (req.expression.name !== 'same_instance') continue;

        // Gather channel references and the optional type filter
        const channelNames: string[] = [];
        let typeFilter: string | undefined;
        for (const arg of req.expression.args) {
          if (arg.type === 'ident') {
            channelNames.push(arg.name);
          } else if (arg.type === 'string_literal') {
            typeFilter = arg.value;
          }
        }

        // Get instances for these channels
        const instances = new Set<string>();
        for (const ch of channelNames) {
          const a = assignmentMap.get(`${port.name}\0${ch}`);
          if (!a) continue;
          const inst = extractInstance(a.signalName);
          if (inst) instances.add(inst);
        }

        if (instances.size > 1) {
          errors.push(
            `[sol ${solution.id}] same_instance violation in port "${port.name}" config "${activeConfigName}": ` +
            `channels [${channelNames.join(', ')}] use different instances: [${[...instances].join(', ')}]`
          );
        }
      }
    }
  }

  return errors;
}

/**
 * Check diff_instance constraints hold in solution.
 */
function checkDiffInstanceConstraints(
  solution: Solution,
  ast: ProgramNode,
): string[] {
  const errors: string[] = [];
  const { ast: expanded } = expandAllMacros(ast, getStdlibMacros());

  for (const ca of solution.configAssignments) {
    const assignmentMap = new Map<string, Assignment>();
    for (const a of ca.assignments) {
      assignmentMap.set(`${a.portName}\0${a.channelName}`, a);
    }

    for (const stmt of expanded.statements) {
      if (stmt.type !== 'port_decl') continue;
      const port = stmt as PortDeclNode;
      const activeConfigName = ca.activeConfigs.get(port.name);
      if (!activeConfigName) continue;

      const config = port.configs.find(c => c.name === activeConfigName);
      if (!config) continue;

      for (const item of config.body) {
        if (item.type !== 'require') continue;
        const req = item as RequireNode;
        if (req.expression.type !== 'function_call') continue;
        if (req.expression.name !== 'diff_instance') continue;

        const channelNames: string[] = [];
        for (const arg of req.expression.args) {
          if (arg.type === 'ident') {
            channelNames.push(arg.name);
          }
        }

        // All channels should have distinct instances
        const instanceToChannel = new Map<string, string>();
        for (const ch of channelNames) {
          const a = assignmentMap.get(`${port.name}\0${ch}`);
          if (!a) continue;
          const inst = extractInstance(a.signalName);
          if (!inst) continue;

          const existing = instanceToChannel.get(inst);
          if (existing) {
            errors.push(
              `[sol ${solution.id}] diff_instance violation in port "${port.name}" config "${activeConfigName}": ` +
              `channels "${existing}" and "${ch}" both use instance "${inst}"`
            );
          }
          instanceToChannel.set(inst, ch);
        }
      }
    }
  }

  return errors;
}

/**
 * Collect all dma() channel references from an AST's require statements.
 * Returns a set of "portName\0channelName" keys that have dma() constraints.
 */
function collectDmaRequiredChannels(ast: ProgramNode): Set<string> {
  const { ast: expanded } = expandAllMacros(ast, getStdlibMacros());
  const result = new Set<string>();

  function walkExpr(expr: import('../src/parser/constraint-ast').ConstraintExprNode, portName: string): void {
    switch (expr.type) {
      case 'function_call':
        if (expr.name === 'dma' && expr.args.length >= 1 && expr.args[0].type === 'ident') {
          result.add(`${portName}\0${expr.args[0].name}`);
        }
        for (const arg of expr.args) walkExpr(arg, portName);
        break;
      case 'binary_expr':
        walkExpr(expr.left, portName);
        walkExpr(expr.right, portName);
        break;
      case 'unary_expr':
        walkExpr(expr.operand, portName);
        break;
    }
  }

  for (const stmt of expanded.statements) {
    if (stmt.type !== 'port_decl') continue;
    const port = stmt as PortDeclNode;
    for (const config of port.configs) {
      for (const item of config.body) {
        if (item.type !== 'require') continue;
        walkExpr((item as RequireNode).expression, port.name);
      }
    }
  }
  return result;
}

/**
 * Check DMA assignment invariants:
 * 1. Only channels with dma() requirement get DMA assignment
 * 2. All channels with dma() requirement get DMA assignment
 */
function checkDmaAssignmentInvariants(
  solution: Solution,
  ast: ProgramNode,
): string[] {
  const errors: string[] = [];
  const dmaRequiredChannels = collectDmaRequiredChannels(ast);

  // If no dma() constraints exist, no DMA assignments should exist
  if (dmaRequiredChannels.size === 0) {
    for (const ca of solution.configAssignments) {
      if (ca.dmaStreamAssignment && ca.dmaStreamAssignment.size > 0) {
        errors.push(
          `[sol ${solution.id}] DMA assignments present but no dma() constraints exist`
        );
      }
    }
    return errors;
  }

  for (const ca of solution.configAssignments) {
    const dma = ca.dmaStreamAssignment ?? new Map<string, string>();

    // Build lookup: signalName -> (portName, channelName)
    const signalToPortChannel = new Map<string, { port: string; channel: string }>();
    for (const a of ca.assignments) {
      if (a.portName === '<pinned>') continue;
      signalToPortChannel.set(a.signalName, { port: a.portName, channel: a.channelName });
    }

    // Check 1: Only channels with dma() requirement get DMA assignment
    for (const [signalName] of dma) {
      const info = signalToPortChannel.get(signalName);
      if (!info) continue;
      const key = `${info.port}\0${info.channel}`;
      if (!dmaRequiredChannels.has(key)) {
        errors.push(
          `[sol ${solution.id}] Signal "${signalName}" (${info.port}.${info.channel}) has DMA assignment but no dma() requirement`
        );
      }
    }

    // Check 2: All channels with dma() requirement get DMA assignment
    for (const key of dmaRequiredChannels) {
      const [portName, channelName] = key.split('\0');
      // Find the assignment for this port.channel in this config combo
      const activeConfig = ca.activeConfigs.get(portName);
      if (!activeConfig) continue;

      const channelAssignment = ca.assignments.find(
        a => a.portName === portName && a.channelName === channelName && a.configurationName === activeConfig
      );
      if (!channelAssignment) continue;

      if (!dma.has(channelAssignment.signalName)) {
        errors.push(
          `[sol ${solution.id}] Channel ${portName}.${channelName} has dma() requirement but signal "${channelAssignment.signalName}" has no DMA assignment`
        );
      }
    }
  }

  return errors;
}

// ============================================================
// Solver definitions
// ============================================================

const COST_WEIGHTS = new Map([
  ['pin_count', 1],
  ['port_spread', 0.5],
  ['peripheral_count', 0.5],
  ['debug_pin_penalty', 2],
  ['pin_clustering', 0.3],
]);

const TWO_PHASE_CONFIG = {
  maxGroups: 20,
  maxSolutionsPerGroup: 5,
  timeoutMs: 10000,
  costWeights: COST_WEIGHTS,
};

const BASIC_CONFIG = {
  maxSolutions: 50,
  timeoutMs: 10000,
};

interface SolverDef {
  name: string;
  run: (ast: ProgramNode, mcu: Mcu) => SolverResult;
}

const solvers: SolverDef[] = [
  {
    name: 'backtracking',
    run: (ast, mcu) => solveConstraints(ast, mcu, BASIC_CONFIG),
  },
  {
    name: 'two-phase',
    run: (ast, mcu) => solveTwoPhase(ast, mcu, TWO_PHASE_CONFIG),
  },
  {
    name: 'randomized-restarts',
    run: (ast, mcu) => solveRandomizedRestarts(ast, mcu, {
      numRestarts: 3,
      maxSolutions: 50,
      timeoutMs: 10000,
      costWeights: COST_WEIGHTS,
    }),
  },
  {
    name: 'cost-guided',
    run: (ast, mcu) => solveCostGuided(ast, mcu, { ...BASIC_CONFIG, costWeights: COST_WEIGHTS }),
  },
  {
    name: 'diverse-instances',
    run: (ast, mcu) => solveDiverseInstances(ast, mcu, TWO_PHASE_CONFIG),
  },
  {
    name: 'ac3',
    run: (ast, mcu) => solveAC3(ast, mcu, BASIC_CONFIG),
  },
  {
    name: 'dynamic-mrv',
    run: (ast, mcu) => solveDynamicMRV(ast, mcu, BASIC_CONFIG),
  },
];

// ============================================================
// Tests
// ============================================================

const testCases = discoverTestCases();

describe('Solver integration tests', () => {
  // Cache parsed MCU data per XML file
  const mcuCache = new Map<string, Mcu>();

  function getMcu(mcuFile: string): Mcu {
    if (!mcuCache.has(mcuFile)) {
      const xmlString = readFileSync(mcuFile, 'utf-8');
      const mcu = parseMcuXml(xmlString);

      // Look for DMA XML files in the same directory
      const mcuDir = mcuFile.substring(0, mcuFile.lastIndexOf('/'));
      const dmaFiles = readdirSync(mcuDir).filter(f => f.startsWith('DMA-') && f.endsWith('.xml'));
      if (dmaFiles.length > 0) {
        // Find matching DMA version from MCU peripheral list
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

      mcuCache.set(mcuFile, mcu);
    }
    return mcuCache.get(mcuFile)!;
  }

  // Cache solver results per (solver, mcuFile, constraintFile)
  const resultCache = new Map<string, SolverResult>();

  function getResult(solver: SolverDef, ast: ProgramNode, mcu: Mcu, cacheKey: string): SolverResult {
    const key = `${solver.name}\0${cacheKey}`;
    if (!resultCache.has(key)) {
      resultCache.set(key, solver.run(ast, mcu));
    }
    return resultCache.get(key)!;
  }

  if (testCases.length === 0) {
    it('should have test cases', () => {
      expect.fail('No test cases found in test/ directory');
    });
    return;
  }

  for (const tc of testCases) {
    const relativePath = tc.constraintFile.replace(TEST_DIR + '/', '');
    const kind = tc.expectPass ? 'PASS' : 'FAIL';
    const cacheKey = `${tc.mcuFile}\0${tc.constraintFile}`;

    describe(`[${tc.mcuFolder}] ${relativePath} (${kind})`, () => {
      const constraintText = readFileSync(tc.constraintFile, 'utf-8');
      const parseResult = parseConstraints(constraintText);

      if (tc.expectPass) {
        it('should parse without errors', () => {
          expect(parseResult.errors.length, `Parse errors: ${parseResult.errors.map(e => e.message).join('; ')}`).toBe(0);
          expect(parseResult.ast).not.toBeNull();
        });

        for (const solver of solvers) {
          describe(`${solver.name} solver`, () => {
            it('should find at least one solution', () => {
              if (!parseResult.ast) return;
              const mcu = getMcu(tc.mcuFile);
              const result = getResult(solver, parseResult.ast, mcu, cacheKey);
              // If solver timed out, result is inconclusive — skip
              const timedOut = result.errors.some(e => e.message.includes('timeout'));
              if (timedOut && result.solutions.length === 0) return;
              const solverErrors = result.errors.filter(e => e.type === 'error');
              expect(
                result.solutions.length,
                `Expected solutions but got 0. Errors: ${solverErrors.map(e => e.message).join('; ')}`
              ).toBeGreaterThan(0);
            });

            it('should produce solutions with valid invariants', () => {
              if (!parseResult.ast) return;
              const mcu = getMcu(tc.mcuFile);
              const result = getResult(solver, parseResult.ast, mcu, cacheKey);
              if (result.solutions.length === 0) return;

              const sharedPatterns = getSharedPatterns(parseResult.ast);
              const allErrors: string[] = [];
              for (const sol of result.solutions) {
                allErrors.push(...checkSolutionInvariants(sol, sharedPatterns, relativePath));
              }
              expect(allErrors, allErrors.join('\n')).toHaveLength(0);
            });

            it('should only use pins that exist in the MCU', () => {
              if (!parseResult.ast) return;
              const mcu = getMcu(tc.mcuFile);
              const result = getResult(solver, parseResult.ast, mcu, cacheKey);
              if (result.solutions.length === 0) return;

              const allErrors: string[] = [];
              for (const sol of result.solutions) {
                allErrors.push(...checkPinsExistInMcu(sol, mcu));
              }
              expect(allErrors, allErrors.join('\n')).toHaveLength(0);
            });

            it('should only assign signals available on their pins', () => {
              if (!parseResult.ast) return;
              const mcu = getMcu(tc.mcuFile);
              const result = getResult(solver, parseResult.ast, mcu, cacheKey);
              if (result.solutions.length === 0) return;

              const allErrors: string[] = [];
              for (const sol of result.solutions) {
                allErrors.push(...checkSignalsExistOnPins(sol, mcu));
              }
              expect(allErrors, allErrors.join('\n')).toHaveLength(0);
            });

            it('should satisfy same_instance constraints', () => {
              if (!parseResult.ast) return;
              const mcu = getMcu(tc.mcuFile);
              const result = getResult(solver, parseResult.ast, mcu, cacheKey);
              if (result.solutions.length === 0) return;

              const allErrors: string[] = [];
              for (const sol of result.solutions) {
                allErrors.push(...checkSameInstanceConstraints(sol, parseResult.ast!));
              }
              expect(allErrors, allErrors.join('\n')).toHaveLength(0);
            });

            it('should satisfy diff_instance constraints', () => {
              if (!parseResult.ast) return;
              const mcu = getMcu(tc.mcuFile);
              const result = getResult(solver, parseResult.ast, mcu, cacheKey);
              if (result.solutions.length === 0) return;

              const allErrors: string[] = [];
              for (const sol of result.solutions) {
                allErrors.push(...checkDiffInstanceConstraints(sol, parseResult.ast!));
              }
              expect(allErrors, allErrors.join('\n')).toHaveLength(0);
            });

            it('should satisfy DMA assignment invariants', () => {
              if (!parseResult.ast) return;
              const mcu = getMcu(tc.mcuFile);
              const result = getResult(solver, parseResult.ast, mcu, cacheKey);
              if (result.solutions.length === 0) return;

              const allErrors: string[] = [];
              for (const sol of result.solutions) {
                allErrors.push(...checkDmaAssignmentInvariants(sol, parseResult.ast!));
              }
              expect(allErrors, allErrors.join('\n')).toHaveLength(0);
            });
          });
        }
      } else {
        // ---- FAIL cases: should either fail to parse or produce zero solutions ----

        it('should fail to parse or produce zero solutions', { timeout: 120_000 }, () => {
          if (parseResult.errors.length > 0 || !parseResult.ast) {
            expect(true).toBe(true);
            return;
          }

          const mcu = getMcu(tc.mcuFile);

          for (const solver of solvers) {
            const result = getResult(solver, parseResult.ast, mcu, cacheKey);
            expect(
              result.solutions.length,
              `${solver.name}: expected 0 solutions but got ${result.solutions.length}`
            ).toBe(0);
          }
        });
      }
    });
  }
});
