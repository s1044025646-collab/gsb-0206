import { Simulator, indexToLabel } from "../core/simulator";
import { compareStates } from "../core/compare";
import { branchesToCsv, probabilitiesToCsv } from "../core/export";
import { expectation } from "../core/statevector";
import { Circuit, SimConfig, BIT_CONVENTION } from "../core/types";
import { Store } from "../db/database";
import { globalPhase } from "../core/complex";

export interface ServiceOptions {
  dataDir: string;
  config?: SimConfig;
}

export class ApiService {
  readonly store: Store;
  private sim: Simulator;
  private config: SimConfig;

  constructor(opts: ServiceOptions) {
    this.store = new Store(opts.dataDir);
    this.config = opts.config ?? {};
    this.sim = new Simulator(this.config);
  }

  convention() {
    return { convention: BIT_CONVENTION, maxQubits: 12 };
  }

  importCircuit(circuit: Circuit, persist: boolean) {
    // 触发校验
    this.sim.prepare(circuit);
    if (persist) {
      const { id, version } = this.store.saveCircuit(circuit, this.config);
      return { id, version, persisted: true };
    }
    return { persisted: false };
  }

  listCircuits() {
    return this.store.listCircuits();
  }

  loadCircuit(name: string, version?: number) {
    const row = this.store.getCircuitVersion(name, version);
    if (!row) throw new Error(`未找到线路 ${name}${version ? ` v${version}` : ""}`);
    return { id: row.id, version: row.version, circuit: row.parsed };
  }

  /** 逐步执行（返回每步态范数与容差），遇测量停止于纯态部分。 */
  stepThrough(circuit: Circuit, saveAs?: { name: string }) {
    const { state, traces, n } = this.sim.runGates(circuit);
    const amplitudes = state.map((a, index) => ({ index, label: indexToLabel(index, n), re: a.re, im: a.im }));
    const result = {
      qubits: n,
      convention: BIT_CONVENTION,
      traces,
      amplitudes,
      tolerance: this.config.tolerance ?? 1e-9,
    };
    let snapshotId: number | undefined;
    if (saveAs) {
      const saved = this.store.saveCircuit({ ...circuit, name: saveAs.name }, this.config);
      snapshotId = this.store.saveSnapshot(saved.id, saved.version, "steps", {}, result);
    }
    return { ...result, snapshotId };
  }

  exactTree(circuit: Circuit, saveAs?: { name: string }) {
    const r = this.sim.runExact(circuit);
    const n = circuit.qubits;
    const result = {
      convention: BIT_CONVENTION,
      truncated: r.truncated,
      truncReason: r.truncReason ?? null,
      probabilitySum: r.probabilitySum,
      branchCount: r.branches.length,
      branches: r.branches.map((b) => {
        let label = "";
        for (let q = n - 1; q >= 0; q--) label += b.record[q] === undefined ? "*" : b.record[q];
        return {
          label,
          outcomes: b.outcomes,
          weight: b.weight,
          postselected: !!b.postselected,
          amplitudes: b.state.map((a, index) => ({ index, re: a.re, im: a.im })),
        };
      }),
      traces: r.traces,
      note: r.truncated
        ? "达到分支预算，结果不完整，未丢弃低概率分支冒充精确结果。"
        : "精确枚举完成，所有分支权重之和应为 1。",
    };
    let snapshotId: number | undefined;
    if (saveAs) {
      const saved = this.store.saveCircuit({ ...circuit, name: saveAs.name }, this.config);
      snapshotId = this.store.saveSnapshot(saved.id, saved.version, "exact", {}, result);
    }
    return { ...result, snapshotId, csv: branchesToCsv(r.branches, n) };
  }

  sample(circuit: Circuit, shots: number, seed?: number, saveAs?: { name: string }) {
    const r = this.sim.sample(circuit, shots, seed);
    const result = { ...r, reproducible: "相同 seed 与线路产生完全相同的轨迹与计数。" };
    let snapshotId: number | undefined;
    if (saveAs) {
      const saved = this.store.saveCircuit({ ...circuit, name: saveAs.name, seed: r.seed }, this.config);
      snapshotId = this.store.saveSnapshot(saved.id, saved.version, "sample", { shots, seed: r.seed }, result);
    }
    return { ...result, snapshotId };
  }

  probabilities(circuit: Circuit) {
    const rows = this.sim.basisProbabilities(circuit);
    return { convention: BIT_CONVENTION, rows, csv: probabilitiesToCsv(rows) };
  }

  expectation(
    circuit: Circuit,
    terms: { qubit: number; pauli: "X" | "Y" | "Z" }[],
  ) {
    const { state, n } = this.sim.runGates(circuit);
    const { value, realParts } = expectation(state, terms);
    return {
      qubits: n,
      observable: terms.map((t) => `${t.pauli}_${t.qubit}`).join(" ⊗ "),
      value,
      basis: "期望值 = Σ_k Re( conj(psi_k) * (P psi)_k )",
      contributions: realParts.map((p) => ({ ...p, label: indexToLabel(p.index, n) })),
    };
  }

  compare(circuitA: Circuit, circuitB: Circuit) {
    const a = this.sim.runGates(circuitA).state;
    const b = this.sim.runGates(circuitB).state;
    return compareStates(a, b, this.config.tolerance);
  }

  getSnapshot(id: number) {
    const snap = this.store.getSnapshot(id);
    if (!snap) throw new Error(`未找到快照 ${id}`);
    return snap;
  }

  listSnapshots(name: string, version?: number) {
    const row = this.store.getCircuitVersion(name, version);
    if (!row) throw new Error(`未找到线路 ${name}`);
    return { circuit: { id: row.id, version: row.version }, snapshots: this.store.listSnapshots(row.id) };
  }

  /** 直接比较两个已固化态向量快照（用于演示重启读取旧报告）。 */
  compareSnapshotStates(idA: number, idB: number) {
    const sa = this.store.getSnapshot(idA);
    const sb = this.store.getSnapshot(idB);
    if (!sa || !sb) throw new Error("快照不存在");
    const toVec = (snap: unknown) =>
      (snap as { amplitudes?: { re: number; im: number }[] }).amplitudes?.map((x) => ({ re: x.re, im: x.im })) ??
      null;
    const va = toVec(sa.result);
    const vb = toVec(sb.result);
    if (!va || !vb) throw new Error("该类型快照不含可比较的态向量");
    const phase = globalPhase(va, vb, this.config.tolerance);
    return { snapshotA: idA, snapshotB: idB, globalPhase: phase, equivalent: phase !== null };
  }

  close() {
    this.store.close();
  }
}
