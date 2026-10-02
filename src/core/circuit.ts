import type { Complex } from "./complex.ts";
import type { Gate } from "./gates.ts";
import { validateGate } from "./gates.ts";
import {
  StateVector,
  MAX_QUBITS,
} from "./statevector.ts";
import type { ClassicalRegister, NormRecord } from "./statevector.ts";

export interface Measurement {
  id: string;
  qubit: number;
  /** 测量结果写入的经典寄存器名。 */
  store: string;
  /** 若设置，则在精确树中只保留该结果（后选择）。 */
  postselect?: 0 | 1;
}

export type Step =
  | { kind: "gate"; gate: Gate }
  | { kind: "measure"; measurement: Measurement };

export interface Circuit {
  id?: number;
  name: string;
  qubits: number;
  /** 长度 2^qubits 的显式初态；省略表示 |0...0>。 */
  initial?: Complex[];
  steps: Step[];
  tolerance: number;
  createdAt?: string;
  version: number;
}

export interface Budget {
  /** 精确分支数量上限。 */
  maxBranches: number;
  /** 执行步数上限（跨所有分支）。 */
  maxSteps: number;
  /** 内存预算（字节，按振幅与分支估算）。 */
  maxBytes: number;
}

export const DEFAULT_BUDGET: Budget = {
  maxBranches: 65536,
  maxSteps: 1_000_000,
  maxBytes: 512 * 1024 * 1024,
};

export function validateCircuit(circuit: Circuit): void {
  if (!circuit.name?.trim()) throw new Error("线路必须有名称");
  if (!Number.isInteger(circuit.qubits) || circuit.qubits < 1 || circuit.qubits > MAX_QUBITS) {
    throw new Error(`量子位数必须为 1..${MAX_QUBITS}`);
  }
  const dim = 2 ** circuit.qubits;
  if (circuit.initial) {
    if (circuit.initial.length !== dim) throw new Error(`初态维度必须为 ${dim}`);
    let n = 0;
    for (const a of circuit.initial) n += a.re * a.re + a.im * a.im;
    if (Math.abs(n - 1) > (circuit.tolerance ?? 1e-9)) {
      throw new Error(`初态必须归一化，当前范数平方=${n}`);
    }
  }
  const stores = new Set<string>();
  circuit.steps.forEach((step, i) => {
    if (step.kind === "gate") {
      validateGate(step.gate, circuit.qubits);
      if (step.gate.condition && !stores.has(step.gate.condition.bit)) {
        throw new Error(`第 ${i} 步引用了尚未测量的经典位 ${step.gate.condition.bit}`);
      }
    } else {
      const m = step.measurement;
      if (m.qubit < 0 || m.qubit >= circuit.qubits) throw new Error(`测量位 ${m.qubit} 非法`);
      if (!m.store.trim()) throw new Error("测量必须指定 store 经典位名");
      stores.add(m.store);
    }
  });
}

export interface ExecutionSnapshot {
  stepIndex: number;
  state: StateVector;
  norms: NormRecord[];
  measured: ClassicalRegister;
}

/**
 * 不含测量分支的单条轨迹执行，用于逐步 API。
 * 测量步骤必须指定 result（后选择或交互给定），零概率会抛错。
 */
export class StepExecutor {
  state: StateVector;
  norms: NormRecord[] = [];
  measured: ClassicalRegister = {};
  stepIndex = 0;
  tolerance: number;

  constructor(circuit: Circuit) {
    this.state = new StateVector(circuit.qubits, circuit.initial);
    this.state.assertNormalized(circuit.tolerance);
    this.tolerance = circuit.tolerance;
  }

  canExecute(step: Step): boolean {
    if (step.kind === "measure") return true;
    const cond = step.gate.condition;
    return !cond || this.measured[cond.bit] === cond.expected;
  }

  /** 执行一步；measure 需要给定结果。返回测量概率与是否坍缩。 */
  execute(step: Step, forcedResult?: 0 | 1): { measured?: { bit: string; result: 0 | 1; probability: number }; skipped?: boolean } {
    const normBefore = this.state.norm();
    if (step.kind === "gate") {
      if (!this.canExecute(step)) {
        this.norms.push({
          step: this.stepIndex++,
          gate: `skip:${step.gate.type}`,
          gateId: step.gate.id,
          normBefore,
          normAfter: normBefore,
          deviation: Math.abs(normBefore - 1),
        });
        return { skipped: true };
      }
      this.state.classical = this.measured;
      this.state.applyGate(step.gate);
      const normAfter = this.state.norm();
      this.norms.push({
        step: this.stepIndex++,
        gate: step.gate.type,
        gateId: step.gate.id,
        normBefore,
        normAfter,
        deviation: Math.abs(normAfter - 1),
      });
      if (Math.abs(normAfter - 1) > this.tolerance) {
        throw new Error(`门 ${step.gate.type} 后范数偏差 ${Math.abs(normAfter - 1)} 超过容差 ${this.tolerance}`);
      }
      return {};
    }
    const m = step.measurement;
    const [p0, p1] = this.state.bitProbability(m.qubit);
    const probs = [p0, p1] as const;
    let result = forcedResult;
    if (result === undefined) {
      if (p0 === 0) result = 1;
      else if (p1 === 0) result = 0;
      else throw new Error("分叉测量需要指定结果，请使用测量树或抽样");
    }
    const probability = probs[result];
    if (probability <= this.tolerance) {
      throw new Error(`零概率后选择被拒绝：测量 ${m.store}（q${m.qubit}）=${result}，概率=${probability}`);
    }
    this.state.project(m.qubit, result);
    this.measured[m.store] = result;
    this.state.classical = this.measured;
    const normAfter = this.state.norm();
    this.norms.push({
      step: this.stepIndex++,
      gate: `measure(${m.store}=${result})`,
      normBefore,
      normAfter,
      deviation: Math.abs(normAfter - 1),
    });
    return { measured: { bit: m.store, result, probability } };
  }
}

/** 执行无分叉线路到终点；测量全部通过 forcedResults 映射。 */
export function runSingle(
  circuit: Circuit,
  forcedResults?: Record<string, 0 | 1>,
): { state: StateVector; norms: NormRecord[]; measured: ClassicalRegister; trajectory: Array<{ bit: string; result: 0 | 1; probability: number }> } {
  const ex = new StepExecutor(circuit);
  const trajectory: Array<{ bit: string; result: 0 | 1; probability: number }> = [];
  for (const step of circuit.steps) {
    const r = ex.execute(step, step.kind === "measure" ? forcedResults?.[step.measurement.store] : undefined);
    if (r.measured) trajectory.push(r.measured);
  }
  return { state: ex.state, norms: ex.norms, measured: ex.measured, trajectory };
}
