import type { Complex } from "./complex.ts";
import { c } from "./complex.ts";
import type { Budget, Circuit, Step } from "./circuit.ts";
import { StateVector, seededRng } from "./statevector.ts";

export interface Branch {
  /** 从根到当前分支的测量序列。 */
  outcomes: Array<{ bit: string; qubit: number; result: 0 | 1 }>;
  /** 联合概率：各次条件概率的乘积（沿同一条坍缩路径）。 */
  weight: number;
  amps: Complex[];
  measured: Record<string, 0 | 1>;
  /** 每个分支终态归一（条件态）；未归一分支态可由 weight 恢复。 */
  normalized: boolean;
  postselectRejected?: string;
}

export interface ExactTreeResult {
  complete: boolean;
  reason?: string;
  branches: Branch[];
  totalWeight: number;
  branchesEnumerated: number;
  stepsExecuted: number;
  bytesEstimate: number;
  budget: Budget;
  postselectRejections: string[];
}

interface ActiveBranch {
  state: StateVector;
  weight: number;
  outcomes: Branch["outcomes"];
  measured: Record<string, 0 | 1>;
}

export function estimateBytes(qubits: number, branchCount: number): number {
  const ampBytes = 16; // 两个 float64
  return 2 ** qubits * ampBytes * branchCount;
}

/**
 * 精确枚举测量树。
 * - 每个测量把当前分支按条件概率拆成两个（后选择只保留指定结果）；
 * - 权重 = 沿路径历次测量概率的乘积，保持纠缠的联合分布；
 * - 达到预算则 complete=false，绝不丢弃低概率分支后冒充精确结果。
 */
export function exactTree(circuit: Circuit, budget: Budget): ExactTreeResult {
  const root: ActiveBranch = {
    state: new StateVector(circuit.qubits, circuit.initial),
    weight: 1,
    outcomes: [],
    measured: {},
  };
  root.state.assertNormalized(circuit.tolerance);
  let active: ActiveBranch[] = [root];
  let stepsExecuted = 0;
  const rejections: string[] = [];

  for (const step of circuit.steps) {
    const next: ActiveBranch[] = [];
    for (const br of active) {
      stepsExecuted++;
      if (stepsExecuted > budget.maxSteps) {
        return finish(active, next, false, "超过步数预算", stepsExecuted, budget, rejections, circuit.qubits);
      }
      if (step.kind === "gate") {
        br.state.classical = br.measured;
        br.state.applyGate(step.gate);
        if (Math.abs(br.state.norm() - 1) > circuit.tolerance) {
          throw new Error(`分支门后范数超差：${step.gate.type}`);
        }
        next.push(br);
      } else {
        const m = step.measurement;
        const [p0, p1] = br.state.bitProbability(m.qubit);
        const options: Array<{ result: 0 | 1; p: number }> =
          m.postselect === undefined
            ? [
                { result: 0, p: p0 },
                { result: 1, p: p1 },
              ]
            : [{ result: m.postselect, p: m.postselect === 0 ? p0 : p1 }];

        for (const opt of options) {
          if (opt.p <= circuit.tolerance) {
            if (m.postselect !== undefined) {
              rejections.push(
                `零概率后选择：${m.store}(q${m.qubit})=${opt.result}，父分支权重=${br.weight}`,
              );
            }
            continue;
          }
          const child: ActiveBranch = {
            state: br.state.clone(),
            weight: br.weight * opt.p,
            outcomes: [...br.outcomes, { bit: m.store, qubit: m.qubit, result: opt.result }],
            measured: { ...br.measured },
          };
          child.state.project(m.qubit, opt.result);
          child.measured[m.store] = opt.result;
          next.push(child);
        }
      }
    }
    active = next;
    if (active.length > budget.maxBranches) {
      return finish(active, [], false, "超过分支数预算", stepsExecuted, budget, rejections, circuit.qubits);
    }
    if (estimateBytes(circuit.qubits, active.length) > budget.maxBytes) {
      return finish(active, [], false, "超过内存预算", stepsExecuted, budget, rejections, circuit.qubits);
    }
  }
  return finish(active, [], true, undefined, stepsExecuted, budget, rejections, circuit.qubits);
}

function finish(
  active: ActiveBranch[],
  pending: ActiveBranch[],
  complete: boolean,
  reason: string | undefined,
  stepsExecuted: number,
  budget: Budget,
  rejections: string[],
  qubits: number,
): ExactTreeResult {
  const all = active.concat(pending);
  const branches: Branch[] = all.map((br) => ({
    outcomes: br.outcomes,
    weight: br.weight,
    amps: br.state.amps.map((a) => c(a.re, a.im)),
    measured: { ...br.measured },
    normalized: true,
  }));
  const totalWeight = branches.reduce((s, b) => s + b.weight, 0);
  return {
    complete,
    reason,
    branches,
    totalWeight,
    branchesEnumerated: branches.length,
    stepsExecuted,
    bytesEstimate: estimateBytes(qubits, branches.length),
    budget,
    postselectRejections: rejections,
  };
}

export interface SampleResult {
  seed: number;
  shots: number;
  counts: Record<string, number>;
  /** 每次 shot 的完整测量序列（保持顺序与条件化）。 */
  records: Array<{ outcomes: Branch["outcomes"]; measured: Record<string, 0 | 1> }>;
  postselectFailures: number;
  postselectRejections: string[];
}

/**
 * 固定种子多次抽样。关键：同一次 shot 沿同一条坍缩后的状态继续，
 * 每次随机数仅决定当前条件分布，不独立抽各量子位边缘。
 * 含后选择时失败的 shot 不计入 counts。
 */
export function sample(circuit: Circuit, shots: number, seed: number): SampleResult {
  if (!Number.isInteger(shots) || shots <= 0) throw new Error("shots 必须为正整数");
  const rng = seededRng(seed);
  const counts: Record<string, number> = {};
  const records: SampleResult["records"] = [];
  const rejections: string[] = [];
  let failures = 0;

  outer: for (let shot = 0; shot < shots; shot++) {
    const state = new StateVector(circuit.qubits, circuit.initial);
    state.assertNormalized(circuit.tolerance);
    const measured: Record<string, 0 | 1> = {};
    const outcomes: Branch["outcomes"] = [];

    for (const step of circuit.steps) {
      if (step.kind === "gate") {
        state.classical = measured;
        state.applyGate(step.gate);
      } else {
        const m = step.measurement;
        const [p0, p1] = state.bitProbability(m.qubit);
        if (m.postselect !== undefined) {
          const p = m.postselect === 0 ? p0 : p1;
          if (p <= circuit.tolerance) {
            failures++;
            rejections.push(
              `shot ${shot}: 零概率后选择 ${m.store}(q${m.qubit})=${m.postselect}`,
            );
            continue outer;
          }
          state.project(m.qubit, m.postselect);
          measured[m.store] = m.postselect;
          outcomes.push({ bit: m.store, qubit: m.qubit, result: m.postselect });
        } else {
          const r = rng();
          const result: 0 | 1 = r < p0 ? 0 : 1;
          state.project(m.qubit, result);
          measured[m.store] = result;
          outcomes.push({ bit: m.store, qubit: m.qubit, result });
        }
      }
    }
    const key = outcomes.map((o) => `${o.bit}=${o.result}`).join(",");
    counts[key] = (counts[key] ?? 0) + 1;
    records.push({ outcomes, measured });
  }

  return { seed, shots, counts, records, postselectFailures: failures, postselectRejections: rejections };
}

export { type Step };
