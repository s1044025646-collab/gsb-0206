import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { Budget, Circuit } from "./circuit.ts";
import { DEFAULT_BUDGET, StepExecutor, validateCircuit } from "./circuit.ts";
import { exactTree, sample } from "./measurement.ts";
import { compareStates, pauliExpectation, StateVector } from "./statevector.ts";
import type { PauliString } from "./statevector.ts";
import { branchesCSV, samplesCSV, statevectorCSV, toJSON } from "./export.ts";
import { denseApply, denseMatrix, matrix2, validateGate } from "./gates.ts";
import { Store } from "./store.ts";
import type { Complex } from "./complex.ts";

export interface ServiceConfig {
  dataDir: string;
}

export class SimulationService {
  store: Store;

  constructor(config: ServiceConfig) {
    this.store = new Store(resolve(config.dataDir, "quantum.sqlite"));
  }

  importCircuit(input: unknown): Circuit {
    const circuit = normalizeCircuit(input);
    validateCircuit(circuit);
    return circuit;
  }

  saveCircuit(input: unknown): { name: string; version: number; id: number; createdAt: string } {
    const circuit = this.importCircuit(input);
    const saved = this.store.saveCircuit(circuit);
    return { name: circuit.name, version: saved.version, id: saved.id, createdAt: saved.createdAt };
  }

  load(name: string, version?: number): Circuit {
    const row = this.store.getCircuit(name, version);
    if (!row) throw new Error(`线路不存在：${name}${version ? ` v${version}` : ""}`);
    return row;
  }

  /** 逐步执行器：外部每步调 stepNext 直到结束。 */
  executor(circuit: Circuit): StepExecutor {
    return new StepExecutor(circuit);
  }

  stateView(sv: StateVector) {
    return {
      qubits: sv.qubits,
      convention:
        "qubit 0 为最高有效位；index 的二进制即 |q0 q1 ... qn-1>；振幅顺序按计算基整数升序",
      dimension: sv.dimension,
      norm: sv.norm(),
      amplitudes: sv.amps.map((a, index) => ({
        index,
        bits: index.toString(2).padStart(sv.qubits, "0"),
        re: a.re,
        im: a.im,
        probability: a.re * a.re + a.im * a.im,
      })),
      measured: { ...sv.classical },
    };
  }

  basisProbabilities(circuit: Circuit, forcedResults?: Record<string, 0 | 1>) {
    const ex = new StepExecutor(circuit);
    const trace: unknown[] = [];
    circuit.steps.forEach((step, i) => {
      const forced = step.kind === "measure" ? forcedResults?.[step.measurement.store] : undefined;
      const result = ex.execute(step, forced);
      trace.push({
        step: i,
        kind: step.kind,
        skipped: result.skipped ?? false,
        measured: result.measured ?? null,
        norm: ex.norms[i]!,
      });
    });
    return {
      basis: this.stateView(ex.state).amplitudes,
      steps: trace,
      measured: ex.measured,
    };
  }

  exact(circuit: Circuit, budget?: Partial<Budget>) {
    const b: Budget = { ...DEFAULT_BUDGET, ...budget };
    return exactTree(circuit, b);
  }

  sampling(circuit: Circuit, shots: number, seed: number) {
    return sample(circuit, shots, seed);
  }

  expectation(circuit: Circuit, pauli: PauliString, forcedResults?: Record<string, 0 | 1>) {
    const run = this.basisProbabilities(circuit, forcedResults);
    const sv = new StateVector(circuit.qubits, run.basis.map((a) => ({ re: a.re, im: a.im })));
    const calc = pauliExpectation(sv, pauli);
    return {
      observable: pauli,
      expectation: calc.expectation,
      convention: "Pauli 字符串按 q0..qn-1 排列；I 表示不作用",
      calculation: calc.contributions,
      measured: run.measured,
    };
  }

  compare(
    circuitA: Circuit,
    circuitB: Circuit,
    forcedA?: Record<string, 0 | 1>,
    forcedB?: Record<string, 0 | 1>,
  ) {
    const a = this.basisProbabilities(circuitA, forcedA);
    const b = this.basisProbabilities(circuitB, forcedB);
    const sa = new StateVector(circuitA.qubits, a.basis.map((x) => ({ re: x.re, im: x.im })));
    const sb = new StateVector(circuitB.qubits, b.basis.map((x) => ({ re: x.re, im: x.im })));
    const result = compareStates(sa, sb, Math.max(circuitA.tolerance, circuitB.tolerance));
    return {
      ...result,
      physicallyEquivalent: result.equal || result.globalPhaseEquivalent,
      note: "globalPhaseEquivalent=true 表示仅差整体相位，物理上不可区分",
    };
  }

  /** 使用独立稠密矩阵乘法核对单/两比特门矩阵酉性及一次门更新。 */
  crossCheckGate(gate: unknown, vector?: Complex[]) {
    const g = gate as Parameters<typeof validateGate>[0] & { target: number };
    validateGate(g, vector ? Math.ceil(Math.log2(vector.length)) : Math.max(g.target + 1, (g.control ?? -1) + 1));
    const matrix = denseMatrix(g);
    const dim = g.type === "CX" ? 4 : 2;
    const identity: Complex[] = Array.from({ length: dim * dim }, (_, i) => ({
      re: i % (dim + 1) === 0 ? 1 : 0,
      im: 0,
    }));
    let checkVec = vector;
    if (!checkVec) {
      checkVec = Array.from({ length: dim }, (_, i) => ({ re: i === 0 ? 1 : 0, im: 0 }));
    }
    const out = denseApply(matrix, checkVec);
    return {
      gate: g,
      dimension: dim,
      denseMatrix: matrix,
      appliedToDenseBasisVector: out,
      note: "该路径使用稠密矩阵乘法独立核对；主模拟使用逐对振幅状态向量更新",
    };
  }

  exportState(circuit: Circuit, format: "json" | "csv", forcedResults?: Record<string, 0 | 1>) {
    const run = this.basisProbabilities(circuit, forcedResults);
    const sv = new StateVector(circuit.qubits, run.basis.map((a) => ({ re: a.re, im: a.im })));
    return format === "csv" ? statevectorCSV(sv) : toJSON(this.stateView(sv));
  }

  exportExact(circuit: Circuit, format: "json" | "csv", budget?: Partial<Budget>) {
    const result = this.exact(circuit, budget);
    return format === "csv" ? branchesCSV(result.branches, circuit.qubits) : toJSON(result);
  }

  exportSamples(circuit: Circuit, shots: number, seed: number, format: "json" | "csv") {
    const result = this.sampling(circuit, shots, seed);
    return format === "csv" ? samplesCSV(result.counts, shots) : toJSON(result);
  }

  snapshot(input: {
    name: string;
    version?: number;
    kind: string;
    config: unknown;
    payload: unknown;
  }) {
    const version = input.version ?? this.store.getCircuit(input.name)?.version;
    if (!version) throw new Error("找不到线路版本");
    const id = this.store.saveSnapshot({
      circuitName: input.name,
      circuitVersion: version,
      kind: input.kind,
      algorithmConfig: input.config,
      payload: input.payload,
    });
    return { snapshotId: id, circuitName: input.name, circuitVersion: version };
  }
}

export function normalizeCircuit(input: unknown): Circuit {
  if (typeof input === "string") {
    return normalizeCircuit(JSON.parse(readFileSync(resolve(input), "utf8")));
  }
  const obj = input as Partial<Circuit>;
  if (!obj || typeof obj !== "object") throw new Error("线路必须是 JSON 对象");
  return {
    name: String(obj.name ?? "circuit"),
    qubits: Number(obj.qubits),
    initial: obj.initial?.map((a) => ({ re: Number(a.re), im: Number(a.im ?? 0) })),
    steps: Array.isArray(obj.steps) ? obj.steps : [],
    tolerance: typeof obj.tolerance === "number" ? obj.tolerance : 1e-9,
    version: Number(obj.version ?? 1),
  };
}

export { matrix2 };
