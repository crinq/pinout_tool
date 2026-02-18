import { readFileSync } from 'fs';
import { join } from 'path';
import { parseMcuXml } from '../src/parser/mcu-xml-parser';
import { parseConstraints } from '../src/parser/constraint-parser';
import { solveConstraints } from '../src/solver/solver';
import { solveAC3 } from '../src/solver/ac3-solver';

const xml = readFileSync(join(__dirname, 'f405v/STM32F405VGTx.xml'), 'utf-8');
const mcu = parseMcuXml(xml);
const constraint = readFileSync(join(__dirname, 'f405v/pass/stmbl.txt'), 'utf-8');
const { ast } = parseConstraints(constraint);

const bt = solveConstraints(ast!, mcu, { maxSolutions: 5, timeoutMs: 10000 });
console.log('Backtracking:', bt.solutions.length, 'solutions,', bt.errors.map(e => `${e.type}: ${e.message}`).join('; '));
console.log('BT stats:', JSON.stringify(bt.statistics));

const ac3 = solveAC3(ast!, mcu, { maxSolutions: 5, timeoutMs: 10000 });
console.log('AC-3:', ac3.solutions.length, 'solutions,', ac3.errors.map(e => `${e.type}: ${e.message}`).join('; '));
console.log('AC-3 stats:', JSON.stringify(ac3.statistics));
