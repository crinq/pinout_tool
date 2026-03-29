# Solvers

The constraint solver maps peripheral signals to MCU pins. Given a set of port declarations (each requesting specific peripherals like SPI, UART, timers) and an MCU definition (pins and their available signal functions), the solver finds valid pin assignments that satisfy all constraints.

All solvers share the same core constraint model:
- **Pin exclusivity**: A pin can only be assigned to one port at a time (pins may be reused across configs of the *same* port).
- **Peripheral instance exclusivity**: A peripheral instance (e.g. SPI1) belongs to one port unless marked `shared`.
- **Channel exclusivity**: Within a port, each pin serves one channel across all configs.
- **Require constraints**: User-defined expressions (e.g. `same_instance(MOSI, MISO)`) checked when all variables of a (port, config) are assigned.

Solutions are ranked by a weighted cost function (see [Settings](#settings)).

---

## Solver Overview

| ID | Name | Type | Best For |
|----|------|------|----------|
| `backtracking` | Backtracking CSP | Single-phase | Simple constraints, fast first solution |
| `two-phase` | Two-Phase | Two-phase | General use, good group diversity |
| `randomized-restarts` | Randomized Restarts | Single-phase | Maximizing solution diversity |
| `cost-guided` | Cost-Guided | Single-phase | Finding low-cost solutions first |
| `diverse-instances` | Diverse Instances | Two-phase | Exploring many peripheral instance combinations |
| `ac3` | AC-3 Forward Checking | Single-phase | Heavily constrained problems |
| `dynamic-mrv` | Dynamic MRV | Single-phase | Heavily constrained problems |
| `priority-backtracking` | Priority Backtracking | Single-phase | Problems with scarce peripherals |
| `priority-two-phase` | Priority Two-Phase | Two-phase | Scarce peripherals + group diversity |
| `priority-diverse` | Priority Diverse | Single-phase | Fast initial solve + diverse exploration |
| `priority-group` | Priority Group | Three-phase | Complex problems needing instance permutation |
| `mrv-group` | MRV Group | Three-phase | Complex problems where priority-group fails |
| `ratio-mrv-group` | Ratio MRV Group | Three-phase | Complex problems with varying port sizes |
| `hybrid` | Hybrid (Single-Phase + Two-Phase) | Hybrid | Problems where two-phase Phase 1 fails but single-phase succeeds |

---

## Single-Phase Solvers

Single-phase solvers assign pins directly to variables using backtracking search. They generate one flat list of solutions, each valid across all config combinations.

### Backtracking CSP

The baseline solver. Sorts variables once by **MRV** (Minimum Remaining Values - smallest domain first), then searches depth-first with backtracking. When all variables of a (port, config) pair are assigned, require constraints are checked eagerly to prune early.

**Strengths**: Fast for simple problems. Low overhead.
**Weaknesses**: Static variable ordering means it can get stuck in unproductive branches. No forward checking - doesn't detect dead-ends until it reaches them. Limited solution diversity (solutions tend to cluster around similar assignments).

**Settings**: `maxSolutions`, `timeoutMs`, `costWeights`, `skipGpioMapping`.

### Randomized Restarts

Runs the backtracking solver N times. Each restart shuffles every variable's candidate domain using a seeded PRNG, then re-sorts by MRV. The shuffled domains break MRV ties differently each round, exploring different regions of the search space.

The solution budget is divided evenly across restarts (`maxSolutions / numRestarts` per round).

**Strengths**: Much better solution diversity than plain backtracking. Reproducible (seeded RNG).
**Weaknesses**: Each restart is independent - no learning between rounds. Can be slow if individual restarts are expensive. The even budget split means early rounds may exhaust their quota on similar solutions.

**Settings**: `numRestarts` (number of restart rounds), `maxSolutions`, `timeoutMs`, `costWeights`, `skipGpioMapping`.

### Cost-Guided

Backtracking with cost-aware candidate ordering. Before trying candidates for each variable, sorts them by estimated incremental cost:
- **Port spread**: Penalty for introducing a new GPIO port letter.
- **Debug pin penalty**: Heavy penalty (10x weight) for SWD/JTAG pins (PA13, PA14, PA15, PB3, PB4).
- **Pin proximity**: Average distance to already-assigned pins in the same port (BGA grid or circular LQFP distance).

**Strengths**: Finds low-cost solutions earlier than other solvers. Good when pin placement quality matters.
**Weaknesses**: Cost estimation overhead at every node. Same static MRV ordering as backtracking - can still get stuck. Limited diversity.

**Settings**: `maxSolutions`, `timeoutMs`, `costWeights` (directly affects candidate ordering), `skipGpioMapping`.

### AC-3 Forward Checking

Backtracking with constraint propagation. After each pin assignment, removes conflicting candidates from other variables' domains:
- Pins assigned to one port are removed from other ports' domains.
- Non-shared peripheral instances assigned to one port are removed from other ports.

Detects **port wipeout** - when all configs of a port have at least one variable with an empty domain, the branch is pruned immediately.

**Strengths**: Detects dead-ends earlier than plain backtracking through domain pruning. Fewer wasted nodes explored.
**Weaknesses**: Propagation overhead per assignment (domain manipulation + wipeout check). Static MRV ordering. The propagation is local (pin/instance exclusivity only) - doesn't propagate require constraints.

**Settings**: `maxSolutions`, `timeoutMs`, `costWeights`, `skipGpioMapping`.

### Dynamic MRV

Instead of sorting variables once upfront, dynamically picks the unassigned variable with the smallest non-empty domain at each step. Combined with the same forward checking as AC-3.

Variables with empty domains (from inactive configs) are skipped. When no non-empty domain variable exists but unassigned variables remain, attempts to complete the solution - these are variables for configs that have no active candidates.

**Strengths**: Adapts variable ordering as domains shrink during search. Better at avoiding dead-ends than static MRV. Forward checking prunes early.
**Weaknesses**: Overhead of scanning all variables to find the minimum at each step (O(n) per node). Single-phase - no instance-level decomposition.

**Settings**: `maxSolutions`, `timeoutMs`, `costWeights`, `skipGpioMapping`.

### Priority Backtracking

Backtracking with **port-priority** variable ordering instead of MRV. Port priority is computed as the sum of unique pins available across all channels of a (port, config) pair - lower means more constrained. Variables from constrained ports are assigned first, ensuring they get the best pin choices before less constrained ports consume shared pins.

MRV is used as a secondary tiebreaker within the same priority level.

**Strengths**: Excellent for problems with scarce peripherals - the most constrained ports get first pick. Fast first solution when priority ordering matches the problem structure.
**Weaknesses**: Can fail entirely on problems where the priority ordering leads to dead-ends that MRV would avoid. No forward checking.

**Settings**: `maxSolutions`, `timeoutMs`, `costWeights`, `skipGpioMapping`.

### Priority Diverse

Hybrid strategy: Round 0 uses port-priority ordering (fast initial solve), remaining rounds use MRV with shuffled domains (diverse exploration). Round 0 gets half the solution budget; the other half is split among the diversity rounds.

**Strengths**: Gets a good first solution fast via priority ordering, then explores alternatives. Best of both worlds.
**Weaknesses**: Inherits priority ordering's dead-end weakness for round 0. If round 0 fails (timeout), half the budget is wasted. No forward checking.

**Settings**: `numRestarts` (total rounds including round 0), `maxSolutions`, `timeoutMs`, `costWeights`, `skipGpioMapping`.

---

## Two-Phase Solvers

Two-phase solvers decompose the problem:
- **Phase 1** (Instance Assignment): Assigns peripheral *instances* (e.g. SPI1, SPI2) to ports - a lightweight CSP without pin-level constraints.
- **Phase 2** (Pin Assignment): For each instance group from Phase 1, filters variable domains to match the chosen instances and runs backtracking to find valid pin mappings.

This decomposition produces **groups** - sets of solutions sharing the same peripheral instance assignments. Different groups may use different SPI/UART/Timer instances, giving users meaningful alternatives.

### Two-Phase (Instance + Pin)

The default solver. Phase 1 solves instance assignment with MRV ordering. Each unique instance group is fingerprinted to avoid duplicates. Phase 2 runs MRV-ordered backtracking per group.

**Strengths**: Good balance of speed and diversity. Instance-level decomposition naturally produces diverse groups. Default choice for most problems.
**Weaknesses**: Phase 1 may find few groups if instance candidates are limited. Phase 2 per-group budget limits total solutions per group.

**Settings**: `maxGroups`, `maxSolutionsPerGroup`, `timeoutMs`, `costWeights`, `skipGpioMapping`.

### Diverse Instances (Two-Phase)

Enhanced two-phase with multi-round instance discovery (up to 10 rounds). Round 0 uses original domain order; rounds 1+ shuffle instance domains to discover different instance combinations.

**Strengths**: Finds more diverse instance groups than plain two-phase. Good for problems with many valid instance configurations.
**Weaknesses**: More overhead from multiple Phase 1 rounds. Each round may find duplicate groups (deduplicated by fingerprint).

**Settings**: `maxGroups`, `maxSolutionsPerGroup`, `timeoutMs`, `costWeights`, `skipGpioMapping`.

### Priority Two-Phase

Two-phase solver with port-priority ordering in both phases. Phase 1 assigns instances to constrained ports first. Phase 2 assigns pins with priority ordering.

**Strengths**: Constrained peripherals get optimal instance and pin choices.
**Weaknesses**: Same priority ordering weakness as priority-backtracking - can fail on some problem structures.

**Settings**: `maxGroups`, `maxSolutionsPerGroup`, `timeoutMs`, `costWeights`, `skipGpioMapping`.

---

## Three-Phase Solvers

Three-phase solvers add an instance permutation step between instance discovery and pin assignment:
- **Phase 1** (Instance Discovery): Multi-round instance group discovery (5 rounds - round 0 with priority ordering, rounds 1-4 with shuffled MRV).
- **Phase 1.5** (Instance Permutation): For each discovered group, generates permutations of same-type peripheral instances across ports. E.g. if ports A and B both use SPI, tries swapping SPI1↔SPI2 between them. Limited to 50 permutations per group and 200 total permuted groups.
- **Phase 2** (Pin Assignment): Backtracking to find valid pin mappings per group.

### Priority Group

Phase 2 uses port-priority ordered backtracking.

**Strengths**: Instance permutation discovers groups that Phase 1 alone would miss. Priority ordering in Phase 2 gives constrained peripherals first pick.
**Weaknesses**: Phase 2 can fail on problems where priority ordering leads to dead-ends. Instance permutation has combinatorial overhead.

**Settings**: `maxGroups`, `maxSolutionsPerGroup`, `timeoutMs`, `costWeights`, `skipGpioMapping`.

### MRV Group

Same Phase 1 and 1.5 as Priority Group, but Phase 2 uses **Dynamic MRV with forward checking** instead of priority ordering.

Port priority in Phase 1 (round 0) uses the raw sum of unique pins across all channels per (port, config). A port with 3 channels having 5, 3, and 4 unique pin candidates gets priority score 12.

**Strengths**: Most robust three-phase solver. Dynamic MRV adapts to domain changes. Forward checking prunes dead-ends early. Succeeds on problems where Priority Group fails.
**Weaknesses**: Phase 2 overhead from dynamic variable selection and propagation. Slower per-node than priority ordering. Raw pin count priority can misjudge ports with many channels - a port with 10 channels and 50 total pins (5 per channel) appears less constrained than a port with 2 channels and 20 total pins (10 per channel), even though the first port is tighter per signal.

**Settings**: `maxGroups`, `maxSolutionsPerGroup`, `timeoutMs`, `costWeights`, `skipGpioMapping`.

### Ratio MRV Group

Variant of MRV Group with **normalized port priority**. Instead of raw pin count, priority is computed as:

```
priority = total_unique_pins / number_of_channels
```

This gives the average number of pin candidates per required signal. A port needing 10 signals with 50 total candidates (ratio 5.0) is correctly ranked as more constrained than a port needing 2 signals with 20 candidates (ratio 10.0).

All other behavior - Phase 1 diversity rounds, Phase 1.5 permutation, Phase 2 dynamic MRV - is identical to MRV Group.

**Strengths**: Better priority ordering for problems where ports have varying numbers of channels. Finds more groups on complex problems (benchmarks show ~50% more groups on ecat_complex vs MRV Group).
**Weaknesses**: Same Phase 2 overhead as MRV Group. On problems where all ports have similar channel counts, behaves identically to MRV Group.

**Settings**: `maxGroups`, `maxSolutionsPerGroup`, `timeoutMs`, `costWeights`, `skipGpioMapping`.

---

## Hybrid Solver

The hybrid solver bridges single-phase and two-phase approaches. It addresses a specific failure mode: when two-phase Phase 1 generates instance groups that all fail Phase 2 (no valid pin routes), but single-phase solvers can find solutions by exploring pin-level assignments directly.

### Hybrid (Single-Phase + Two-Phase)

Four-stage pipeline:
1. **Phase A** (Single-phase solve): Runs priority-backtracking with 30% of the time budget to find solutions quickly.
2. **Phase B** (Group extraction): Reverse-maps pin assignments back to instance groups — extracts which peripheral instance (e.g. SPI1, SPI2) each port was assigned.
3. **Phase C** (Instance permutation): Generates permuted groups by swapping same-type peripheral instances across ports (e.g. if ports ENC0 and ENC1 both use SPI, tries swapping SPI2↔SPI4 between them). Up to 50 permutations per source group, 200 total.
4. **Phase D** (Phase 2 with diversity): Runs round-robin pin-level solving on all groups (source + permuted), ordered by farthest-point diversity sampling.

**Strengths**: Finds diverse instance groups that pure two-phase solvers miss when their Phase 1 converges on infeasible instance combinations. On problems with symmetric ports (e.g. multiple encoders that can use different SPI instances), produces significantly more structural diversity — up to 7x more groups in benchmarks. Also finds groups with lower cost since it starts from known-good solutions.
**Weaknesses**: Depends on priority-backtracking succeeding — if no single-phase solver can find solutions, the hybrid solver also fails. The 30/70 time split means less total Phase 2 budget than dedicated three-phase solvers. Falls back to returning priority-backtracking results when no instance groups can be extracted.

**Settings**: `maxGroups`, `maxSolutionsPerGroup`, `timeoutMs`, `costWeights`, `skipGpioMapping`.

---

## Settings Reference

### Solver Selection

**Solver types** (`solverTypes`): Select which solvers to run. Multiple solvers run in parallel (each in a web worker). Results are merged and deduplicated. Default: `two-phase`.

### Solution Limits

**Max solutions** (`maxSolutions`): Global cap on solutions per solver. For two-phase solvers, this is `maxGroups × maxSolutionsPerGroup`. For single-phase solvers, this is the direct limit. Default: **5000**.

**Max groups** (`maxGroups`): Maximum number of instance groups for two-phase/three-phase solvers. Each group represents a different peripheral instance assignment. Default: **100**.

**Max solutions/group** (`maxSolutionsPerGroup`): Maximum pin-mapping solutions to find per instance group. Default: **25**.

**Restarts** (`numRestarts`): Number of rounds for randomized-restarts and priority-diverse solvers. More restarts = more diversity but slower. Default: **25**.

### Timeout

**Timeout** (`solverTimeoutMs`): Maximum time in milliseconds per solver. The solver stops and returns whatever solutions it has found. Default: **2500ms**.

Increasing the timeout helps with:
- Complex problems that need more search time.
- Three-phase solvers where Phase 1 discovery + Phase 2 mapping is expensive.
- Randomized solvers where later restarts may find new groups.

### Cost Function Weights

Cost functions rank solutions after solving. Weight of 0 disables a function; weight of 1 is normal; weight of 2 doubles its impact. Solutions are sorted by total cost (lower is better).

| Function | Description | Default |
|----------|-------------|---------|
| **Pin Count** | Fewer unique pins used is better. | 1.0 |
| **Port Spread** | Fewer GPIO ports used is better (simpler PCB routing). | 0.2 |
| **Peripheral Count** | Fewer peripheral instances used is better (preserves peripherals for other uses). | 0.5 |
| **Debug Pin Penalty** | Penalty for using SWD/JTAG pins (PA13, PA14, PA15, PB3, PB4). | 0.0 |
| **Pin Clustering** | Bonus for keeping pins on the same GPIO port. | 0.0 |
| **Pin Proximity** | Closer physical pin placement within a port is better. | 1.0 |

### DMA Constraints

When constraints use `dma()`, the solver requires that a DMA modes XML file has been loaded for the MCU. DMA stream assignment follows these rules:

- Each DMA stream is exclusive to one port (no two ports share a stream)
- Within a configuration, each channel with `dma()` gets its own stream
- Different configurations of the same port may reuse streams (configs are mutually exclusive)

The solver verifies consistent DMA stream assignment across all ports via backtracking. On STM32F4 (16 streams with fixed peripheral-to-stream mapping) this is a real constraint; on STM32H7 (16 streams, any peripheral on any stream via DMAMUX) it mainly limits the total number of simultaneous DMA channels.

The **cost-guided** solver also uses port spread, debug pin penalty, and pin proximity during search to order candidates - not just for post-solve ranking.

### Skip GPIO Mapping

**Skip GPIO mapping** (`skipGpioMapping`): When enabled, IN/OUT (GPIO) variables are removed from the solver's search space. Instead of assigning specific GPIO pins, the solver only verifies that enough free assignable pins remain after mapping all other signals.

This dramatically speeds up solving for constraint files with many IN/OUT channels, since GPIO variables have very large candidate domains (every assignable pin on the MCU).

When disabled (default), GPIO pins are assigned like any other signal - each IN/OUT channel gets a specific pin.

---

## Choosing a Solver

**General use**: `two-phase` (default). Good balance of speed, diversity, and reliability.

**Maximum diversity**: `diverse-instances` or `randomized-restarts`. These explore more of the search space through shuffled orderings.

**Best solution quality**: `cost-guided`. Finds low-cost solutions first by sorting candidates during search.

**Heavily constrained problems**: `dynamic-mrv` or `ac3`. Forward checking and dynamic variable selection handle tight constraints better than static ordering.

**Scarce peripherals**: `priority-backtracking` or `priority-diverse`. Constrained ports get first pick of pins.

**Complex problems with many peripherals**: `mrv-group` or `ratio-mrv-group`. Three-phase decomposition with instance permutation discovers groups that other solvers miss. Dynamic MRV in Phase 2 handles the pin assignment robustly. Use `ratio-mrv-group` when ports have varying numbers of channels for better priority normalization.

**Symmetric ports with instance diversity issues**: `hybrid`. When multiple ports use the same peripheral type (e.g. 3 encoder ports each needing SPI) and two-phase solvers find only trivial variations, the hybrid solver extracts working instance groups from single-phase solutions and permutes them. Produces significantly more structural diversity.

**Quick exploration**: Run multiple solvers in parallel. Each solver's strengths complement the others - merge results for the best coverage.
