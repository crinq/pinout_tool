// ============================================================
// MCU Data Model
// ============================================================

export interface McuDatabase {
  mcus: Map<string, Mcu>;
}

export interface Mcu {
  refName: string;
  family: string;
  line: string;
  package: string;
  cores: string[];
  frequency: number;
  flash: number;
  ram: number;
  ccmRam?: number;
  ioCount: number;
  voltage: { min: number; max: number };
  temperature: { min: number; max: number };
  hasPowerPad: boolean;

  peripherals: Peripheral[];
  pins: Pin[];

  // Derived lookup tables
  pinByName: Map<string, Pin>;
  pinByPosition: Map<string, Pin>;
  pinByGpioName: Map<string, Pin>; // base GPIO name (e.g., "PA0") -> Pin
  peripheralByInstance: Map<string, Peripheral>;
  signalToPins: Map<string, Pin[]>;
  typeToInstances: Map<string, string[]>;
  peripheralSignals: Map<string, Set<string>>;
  pinSignalSet: Map<string, Set<string>>;

  // Optional DMA data (attached when DMA XML is available)
  dma?: DmaData;
}

export interface Peripheral {
  instanceName: string;
  type: string;         // normalized
  originalType: string; // from XML
  version: string;
  clockEnable?: string;
  configFile?: string;
}

export type PinType = 'I/O' | 'Power' | 'Reset' | 'Boot' | 'MonoIO';

export interface Pin {
  name: string;
  position: string;
  type: PinType;
  signals: Signal[];

  // Derived
  gpioPort?: string;
  gpioNumber?: number;
  isAssignable: boolean;
}

export interface Signal {
  name: string;
  ioModes?: string;

  // Derived from signal name
  peripheralInstance?: string;
  peripheralType?: string;     // normalized
  instanceNumber?: number;
  signalFunction?: string;
}

// ============================================================
// DMA Data Model
// ============================================================

export interface DmaData {
  version: string;
  streams: DmaStreamInfo[];

  // Derived lookup tables
  signalToDmaStreams: Map<string, DmaStreamInfo[]>;
  instanceToDmaStreams: Map<string, DmaStreamInfo[]>;
}

export interface DmaStreamInfo {
  name: string;         // "DMA1_Stream0"
  controller: string;   // "DMA1"
  streamNumber: number; // 0
  requests: DmaRequest[];
}

export interface DmaRequest {
  /** Normalized signal names (e.g. ["TIM5_CH3", "TIM5_UP"] for "TIM5_CH3/UP") */
  signalNames: string[];
  /** Peripheral instance name (e.g. "TIM5", "ADC1") */
  peripheralInstance: string;
}

// ============================================================
// Project Data Model
// ============================================================

export interface Project {
  name: string;
  mcuPatterns: string[];
  ports: Port[];
  costFunctions: CostFunctionConfig[];
  pinnedAssignments: PinnedAssignment[];
  reservedPins: string[];
  constraintText: string;
  macroLibrary?: string;
}

export interface Port {
  name: string;
  channels: Channel[];
  configurations: Configuration[];
}

export interface Channel {
  name: string;
  allowedPins?: string[];
  description?: string;
}

export interface Configuration {
  name: string;
  channelMappings: ChannelMapping[];
}

export interface ChannelMapping {
  channelName: string;
  signalPatterns: string[];
}

export interface PinnedAssignment {
  pinName: string;
  signalName: string;
  channelRef?: string;
}

export interface CostFunctionConfig {
  id: string;
  enabled: boolean;
  weight: number;
}

// ============================================================
// Solution Data Model
// ============================================================

export interface SolverResult {
  mcuRef: string;
  solutions: Solution[];
  errors: SolverError[];
  statistics: SolverStats;
}

export interface Solution {
  id: number;
  name?: string;
  solverOrigin?: string;
  mcuRef: string;
  configAssignments: ConfigCombinationAssignment[];
  portPeripherals: Map<string, Set<string>>;
  costs: Map<string, number>;
  totalCost: number;
  gpioCount: number;
  clusterSize?: number;
  /** Total number of optional mappings (?=) + optional requires (require?) across active configs */
  optionalTotal: number;
  /** Number of fulfilled optional mappings + satisfied optional requires */
  optionalFulfilled: number;
  /** Cached dedup fingerprint (set during finalizeSolutions, reused by mergeResults) */
  _dedupKey?: string;
  /** Cached unique pin count */
  _pinCount?: number;
  /** Cached unique peripheral count */
  _peripheralCount?: number;
}

export interface ConfigCombinationAssignment {
  activeConfigs: Map<string, string>;
  assignments: Assignment[];
  /** DMA stream assignments: triggerName → stream name (e.g. "USART1_TX" → "DMA2_Stream7"). Only present for channels with dma() constraints. */
  dmaStreamAssignment?: Map<string, string>;
}

export interface Assignment {
  pinName: string;
  signalName: string;
  portName: string;
  channelName: string;
  configurationName: string;
}

export interface SolverError {
  type: 'error' | 'warning';
  message: string;
  source?: string;
  line?: number;
  partialSolution?: Assignment[];
  suggestions?: string[];
}

export interface SolverStats {
  totalCombinations: number;
  evaluatedCombinations: number;
  validSolutions: number;
  solveTimeMs: number;
  configCombinations: number;
  firstSolutionMs?: number;
  lastSolutionMs?: number;
  perSolver?: Record<string, SolverStats>;
}

// ============================================================
// Cross-MCU Compatibility
// ============================================================

export interface CompatibilityResult {
  isCompatible: boolean;
  isCrossMcu: boolean;
  missingPins: Set<string>;              // pin not bonded out on target MCU
  missingSignals: Map<string, string>;   // pinName -> signalName (pin exists but signal unavailable)
  validCount: number;
  totalCount: number;
}

// ============================================================
// App State
// ============================================================

export interface AppState {
  constraintText: string;
  pinnedAssignments: PinnedAssignment[];
  reservedPins: string[];
}

// ============================================================
// Cost Function
// ============================================================

export interface CostFunction {
  id: string;
  name: string;
  description: string;
  compute(solution: Solution, mcu: Mcu): number;
}

// ============================================================
// Custom Export Functions
// ============================================================

export interface CustomExportFunction {
  id: string;
  name: string;
  description: string;
  code: string;
}

