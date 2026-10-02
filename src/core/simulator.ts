import { Complex, abs2, eiph, mul, scale } from "./complex";
import {
  StateVector,
  applyGateStep,
  basisState,
  normalize,
  normSquared,
  probabilities,
} from "./statevector";
import { Circuit, Step, StepTrace, SimConfig, DEFAULT_CONFIG, GateStep, MeasureStep } from "./types";
import { DeterministicRng } from "./rng";
import { validateCircuit } from "./validate";

/** 全寄存器计算基标签：左起第 0 字符为最高位 q_{n-1}。 */
export function indexToLabel(index: number, n: number): string {
  return index.toString(2).padStart(n, "0");
}
/** label 左起为最高位。 */
export function labelToIndex(label: string): number {
  return parseInt(label, 2);
}

export interface Branch {
  /** 该分支的经典测量记录：量子位 -> 0/1。 */
  record: Record<number, number>;
  /** 沿程序顺序的测量结果串（每次测量一个字符/子串）。 */
  outcomes: string[];
  /** 累计概率（含之前所有测量概率的乘积）。 */
  weight: number;
  state: StateVector;
  /** 该分支是否因后选择而保留。 */
  postselected?: boolean;
}

export interface ExactResult {
  branches: Branch[];
  traces: StepTrace[];
  truncated: boolean;
  truncReason?: string;
  probabilitySum: number;
}

export interface SampleResult {
  seed: number;
  shots: number;
  /** 全寄存器位串 -> 次数。 */
  counts: Record<string, number>;
  /** 每条抽样轨迹。 */
  trajectories: { shots: number; finalLabel: string; outcomes: string[] }[];
}

type ClassicalConditions = Record<string, string>;

function gateAllowedByClassical(step: GateStep, rec: Record<number, number>): boolean {
  if (!step.classicalWhen) return true;
  const { register, equals } = step.classicalWhen;
  const got = (rec as unknown as ClassicalConditions)[register];
  return got === equals;
}

function measureOne(
  psi: StateVector,
  qubits: number[],
): { outcomes: { bits: number[]; subState: StateVector; probability: number }[] } {
  // 将被测量子位按取值分组；每个不同结果产生一个分支。
  const groups = new Map<number, { mask: number; prob: number }>();
  for (let i = 0; i < psi.length; i++) {
    let m = 0;
    for (let k = 0; k < qubits.length; k++) {
      if (i & (1 << qubits[k])) m |= 1 << k;
    }
    const g = groups.get(m) ?? { mask: 0, prob: 0 };
    g.prob += abs2(psi[i]);
    groups.set(m, g);
  }
  const ordered = [...groups.entries()]
    .filter(([, g]) => g.prob > 0)
    .sort((a, b) => a[0] - b[0]);
  const outcomes = ordered.map(([m, g]) => {
    const bits: number[] = [];
    for (let k = 0; k < qubits.length; k++) bits.push((m >> k) & 1);
    const subState: StateVector = new Array(psi.length);
    for (let i = 0; i < psi.length; i++) subState[i] = { re: 0, im: 0 };
    for (let i = 0; i < psi.length; i++) {
      let mm = 0;
      for (let k = 0; k < qubits.length; k++) {
        if (i & (1 << qubits[k])) mm |= 1 << k;
      }
      if (mm === m) subState[i] = { ...psi[i] };
    }
    // 归一化坍缩态；若概率为 0 不会进入此分支。
    const norm = Math.sqrt(g.prob);
    for (let i = 0; i < subState.length; i++) {
      subState[i] = scale(subState[i], 1 / norm);
    }
    return { bits, subState, probability: g.prob };
  });
  return { outcomes };
}

export class Simulator {
  private cfg: Required<SimConfig>;
  constructor(cfg: SimConfig = {}) {
    this.cfg = { ...DEFAULT_CONFIG, ...cfg };
  }

  prepare(circuit: Circuit): { n: number; size: number; psi: StateVector } {
    const { n, size } = validateCircuit(circuit);
    let psi: StateVector;
    if (circuit.initial && circuit.initial.length) {
      const r = normalize(circuit.initial.map((a) => ({ ...a })), this.cfg.tolerance);
      psi = r.vec;
    } else {
      psi = basisState(n, 0);
    }
    return { n, size, psi };
  }

  /** 仅执行幺正门（遇到测量前的纯态演化），用于逐步执行与无测量线路。 */
  runGates(circuit: Circuit): { state: StateVector; traces: StepTrace[]; n: number } {
    const { n, psi } = this.prepare(circuit);
    let state = psi;
    const traces: StepTrace[] = [];
    for (const [idx, step] of circuit.steps.entries()) {
      if (step.kind === "measure") break;
      const before = normSquared(state);
      state = applyGateStep(state, step as GateStep);
      const after = normSquared(state);
      traces.push({
        stepIndex: idx,
        kind: "gate",
        normBefore: before,
        normAfter: after,
        normError: Math.abs(after - 1),
      });
    }
    return { state, traces, n };
  }

  /** 精确枚举完整测量树。权重沿树相乘；达到分支预算时标记 truncated，不冒充完成。 */
  runExact(circuit: Circuit): ExactResult {
    const { n, psi } = this.prepare(circuit);
    let active: Branch[] = [{ record: {}, outcomes: [], weight: 1, state: psi }];
    const traces: StepTrace[] = [];
    let truncated = false;
    let truncReason: string | undefined;

    for (const [idx, step] of circuit.steps.entries()) {
      if (step.kind === "gate") {
        const gs = step as GateStep;
        for (const br of active) {
          if (!gateAllowedByClassical(gs, br.record)) continue;
          const before = normSquared(br.state);
          br.state = applyGateStep(br.state, gs);
          const after = normSquared(br.state);
          traces.push({
            stepIndex: idx,
            kind: "gate",
            normBefore: before,
            normAfter: after,
            normError: Math.abs(after - 1),
            note: "按分支记录",
          });
        }
        continue;
      }
      const ms = step as MeasureStep & { register?: string };
      const qubits = ms.qubits ?? Array.from({ length: n }, (_, k) => k);
      const next: Branch[] = [];
      for (const br of active) {
        const { outcomes } = measureOne(br.state, qubits);
        for (const o of outcomes) {
          const bitsStr = o.bits.join("");
          if (ms.postselect !== undefined && bitsStr !== ms.postselect) continue;
          const record: Record<number, number> = { ...br.record };
          qubits.forEach((q, k) => (record[q] = o.bits[k]));
          if (ms.register) {
            (record as unknown as ClassicalConditions)[ms.register] = bitsStr;
          }
          next.push({
            record,
            outcomes: [...br.outcomes, bitsStr],
            weight: br.weight * o.probability,
            state: o.subState,
            postselected: ms.postselect !== undefined,
          });
        }
      }
      if (ms.postselect !== undefined && next.length === 0) {
        throw new Error(
          `步骤 ${idx}: 后选择 "${ms.postselect}" 的概率为 0，该结果不可能出现，已拒绝`,
        );
      }
      if (next.length > this.cfg.maxBranches) {
        truncated = true;
        truncReason = `分支数 ${next.length} 超过预算 ${this.cfg.maxBranches}，精确枚举未完成`;
        active = next.slice(0, this.cfg.maxBranches);
        break;
      }
      active = next;
    }

    const probabilitySum = active.reduce((s, b) => s + b.weight, 0);
    return { branches: active, traces, truncated, truncReason, probabilitySum };
  }

  /** 固定种子多次抽样：同一条轨迹沿坍缩后的分支继续，不做逐位边缘独立抽样。 */
  sample(circuit: Circuit, shots: number, seed?: number): SampleResult {
    const { n, psi } = this.prepare(circuit);
    const usedSeed = seed ?? circuit.seed ?? 1;
    const rng = new DeterministicRng(usedSeed);
    const counts: Record<string, number> = {};
    const trajectories: SampleResult["trajectories"] = [];

    for (let shot = 0; shot < shots; shot++) {
      let state = psi.map((a) => ({ ...a }));
      const record: Record<number, number> = {};
      const outcomes: string[] = [];
      for (const step of circuit.steps) {
        if (step.kind === "gate") {
          if (gateAllowedByClassical(step as GateStep, record)) {
            state = applyGateStep(state, step as GateStep);
          }
          continue;
        }
        const ms = step as MeasureStep & { register?: string };
        const qubits = ms.qubits ?? Array.from({ length: n }, (_, k) => k);
        const { outcomes: outs } = measureOne(state, qubits);
        if (ms.postselect !== undefined) {
          const chosen = outs.find((o) => o.bits.join("") === ms.postselect);
          if (!chosen) {
            throw new Error(`后选择 "${ms.postselect}" 概率为 0，抽样第 ${shot} 条轨迹失败`);
          }
          state = chosen.subState;
          const bitsStr = chosen.bits.join("");
          qubits.forEach((q, k) => (record[q] = chosen.bits[k]));
          if (ms.register) {
            (record as unknown as ClassicalConditions)[ms.register] = bitsStr;
          }
          outcomes.push(bitsStr);
          continue;
        }
        const cum: number[] = [];
        let acc = 0;
        for (const o of outs) {
          acc += o.probability;
          cum.push(acc);
        }
        const pick = rng.choose(cum);
        const chosen = outs[pick];
        state = chosen.subState;
        const bitsStr = chosen.bits.join("");
        qubits.forEach((q, k) => (record[q] = chosen.bits[k]));
        if (ms.register) {
          (record as unknown as ClassicalConditions)[ms.register] = bitsStr;
        }
        outcomes.push(bitsStr);
      }
      // 由测量记录生成全寄存器标签；未测量位标记为 "*"。
      let label = "";
      for (let q = n - 1; q >= 0; q--) {
        label += record[q] === undefined ? "*" : record[q].toString();
      }
      // 全测量时无 "*"。
      const key = label.includes("*") ? label : label;
      counts[key] = (counts[key] ?? 0) + 1;
      trajectories.push({ shots: shot, finalLabel: key, outcomes });
    }
    return { seed: usedSeed, shots, counts, trajectories };
  }

  basisProbabilities(circuit: Circuit): { label: string; index: number; probability: number }[] {
    const { state, n } = this.runGates(circuit);
    return probabilities(state).map((p, index) => ({
      label: indexToLabel(index, n),
      index,
      probability: p,
    }));
  }
}

/** 扩展门步：经典条件控制（测量结果驱动的后续门）。 */
export function classicalControlled(
  gate: Omit<GateStep, "kind" | "classicalWhen">,
  register: string,
  equals: string,
): GateStep {
  return { kind: "gate", ...gate, classicalWhen: { register, equals } } as GateStep;
}

export { eiph, mul };
