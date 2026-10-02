import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { c } from "../src/core/complex.ts";
import type { Circuit } from "../src/core/circuit.ts";
import { denseApply, denseMatrix, inverseGate, isUnitary, matrix2 } from "../src/core/gates.ts";
import { exactTree, sample } from "../src/core/measurement.ts";
import {
  compareStates,
  pauliExpectation,
  seededRng,
  StateVector,
} from "../src/core/statevector.ts";
import { SimulationService } from "../src/core/service.ts";
import { teleportationCircuit } from "../src/cli/demo.ts";

const approx = (actual: number, expected: number, eps = 1e-9, msg = "") =>
  assert.ok(Math.abs(actual - expected) <= eps, `${msg} ${actual} != ${expected}`);

test("计算基编号：q0 是 MSB，H on q0 产生 |00>+|10>", () => {
  const sv = new StateVector(2);
  sv.applySingle({ type: "H", target: 0 }, matrix2({ type: "H", target: 0 }));
  approx(sv.amps[0]!.re, Math.SQRT1_2);
  approx(sv.amps[2]!.re, Math.SQRT1_2);
  approx(sv.amps[1]!.re, 0);
});

test("门和逆门：RX(theta) 后 RX(-theta) 恢复 |0>", () => {
  for (const q of [1, 3, 12]) {
    const sv = new StateVector(q);
    const g = { type: "RX" as const, target: 0, angle: 0.73 };
    sv.applySingle(g);
    sv.applySingle(inverseGate(g));
    approx(sv.amps[0]!.re, 1, 1e-12);
    approx(sv.amps[0]!.im, 0, 1e-12);
    approx(sv.norm(), 1, 1e-12);
  }
});

test("两次 H 的干涉恢复原态（相对相位不丢）", () => {
  const sv = new StateVector(1);
  sv.applySingle({ type: "H", target: 0 });
  sv.applySingle({ type: "H", target: 0 });
  approx(sv.amps[0]!.re, 1);
  approx(sv.amps[1]!.re, 0);
});

test("Bell 态相关测量：精确分支仅 00 与 11，各 1/2", () => {
  const circuit: Circuit = {
    name: "bell-test",
    qubits: 2,
    tolerance: 1e-9,
    version: 1,
    steps: [
      { kind: "gate", gate: { type: "H", target: 0 } },
      { kind: "gate", gate: { type: "CX", control: 0, target: 1 } },
      { kind: "measure", measurement: { id: "a", qubit: 0, store: "a" } },
      { kind: "measure", measurement: { id: "b", qubit: 1, store: "b" } },
    ],
  };
  const result = exactTree(circuit, { maxBranches: 16, maxSteps: 100, maxBytes: 1e8 });
  assert.equal(result.complete, true);
  approx(result.totalWeight, 1);
  assert.equal(result.branches.length, 2);
  const keys = result.branches.map((b) => b.outcomes.map((o) => o.result).join("")).sort();
  assert.deepEqual(keys, ["00", "11"]);
});

test("独立稠密矩阵乘法核对状态向量门更新", () => {
  for (const type of ["H", "X", "Y", "Z", "S", "T"] as const) {
    const gate = { type, target: 0 };
    assert.equal(isUnitary(gate), true, `${type} 应酉`);
    const sv = new StateVector(1);
    sv.applySingle(gate);
    const vec = [c(1), c(0)];
    const dense = denseApply(denseMatrix(gate), vec);
    for (let i = 0; i < 2; i++) {
      approx(sv.amps[i]!.re, dense[i]!.re, 1e-12, type);
      approx(sv.amps[i]!.im, dense[i]!.im, 1e-12, type);
    }
  }
});

test("Pauli 期望：Bell 态 <ZZ>=1，<XX>=1，<YY>=-1", () => {
  const circuit: Circuit = {
    name: "bell-pauli",
    qubits: 2,
    tolerance: 1e-9,
    version: 1,
    steps: [
      { kind: "gate", gate: { type: "H", target: 0 } },
      { kind: "gate", gate: { type: "CX", control: 0, target: 1 } },
    ],
  };
  const sv = new StateVector(2);
  sv.applyGate({ type: "H", target: 0 });
  sv.applyGate({ type: "CX", control: 0, target: 1 });
  approx(pauliExpectation(sv, "ZZ").expectation, 1);
  approx(pauliExpectation(sv, "XX").expectation, 1);
  approx(pauliExpectation(sv, "YY").expectation, -1);
  approx(pauliExpectation(sv, "ZI").expectation, 0);
});

test("整体相位等价，相对相位不等价，不做重归一掩盖", () => {
  const a = new StateVector(1, [c(0, 1), c(0)]);
  const b = new StateVector(1, [c(1), c(0)]);
  const r = compareStates(a, b);
  assert.equal(r.globalPhaseEquivalent, true);
  assert.equal(r.equal, false);
  const d = new StateVector(1, [c(Math.SQRT1_2), c(Math.SQRT1_2)]);
  const e = new StateVector(1, [c(Math.SQRT1_2), c(0, -Math.SQRT1_2)]);
  const rel = compareStates(d, e);
  assert.equal(rel.globalPhaseEquivalent, false);
  assert.throws(() => new StateVector(1, [c(2), c(0)]).assertNormalized(1e-9));
});

test("中途测量后的经典条件修正（传态核心）", () => {
  const circuit: Circuit = {
    name: "conditional",
    qubits: 2,
    tolerance: 1e-9,
    version: 1,
    steps: [
      { kind: "gate", gate: { type: "X", target: 0 } },
      { kind: "measure", measurement: { id: "m", qubit: 0, store: "a" } },
      { kind: "gate", gate: { type: "X", target: 1, condition: { bit: "a", expected: 1 } } },
    ],
  };
  const exact = exactTree(circuit, { maxBranches: 8, maxSteps: 100, maxBytes: 1e8 });
  assert.equal(exact.branches.length, 1);
  // 坍缩到 q0=1，条件 X 使 q1=1 => |11>
  approx(exact.branches[0]!.amps[3]!.re, 1);
});

test("不可能的零概率后选择必须拒绝并说明原因", () => {
  const circuit: Circuit = {
    name: "impossible-postselect",
    qubits: 1,
    tolerance: 1e-12,
    version: 1,
    steps: [{ kind: "measure", measurement: { id: "m", qubit: 0, store: "a", postselect: 1 } }],
  };
  const result = exactTree(circuit, { maxBranches: 8, maxSteps: 100, maxBytes: 1e8 });
  assert.equal(result.branches.length, 0);
  assert.match(result.postselectRejections[0]!, /零概率后选择/);
});

test("预算超限明确未完成，不冒充精确", () => {
  const circuit: Circuit = {
    name: "budget",
    qubits: 4,
    tolerance: 1e-9,
    version: 1,
    steps: [0, 1, 2, 3].flatMap((q) => [
      { kind: "gate" as const, gate: { type: "H" as const, target: q } },
      { kind: "measure" as const, measurement: { id: `m${q}`, qubit: q, store: `m${q}` } },
    ]),
  };
  const result = exactTree(circuit, { maxBranches: 3, maxSteps: 100, maxBytes: 1e8 });
  assert.equal(result.complete, false);
  assert.match(result.reason!, /预算/);
});

test("固定种子抽样可复现，且联合相关性正确", () => {
  const r1 = seededRng(42)();
  const r2 = seededRng(42)();
  assert.equal(r1, r2);
  const circuit: Circuit = {
    name: "sample-bell",
    qubits: 2,
    tolerance: 1e-9,
    version: 1,
    steps: [
      { kind: "gate", gate: { type: "H", target: 0 } },
      { kind: "gate", gate: { type: "CX", control: 0, target: 1 } },
      { kind: "measure", measurement: { id: "a", qubit: 0, store: "a" } },
      { kind: "measure", measurement: { id: "b", qubit: 1, store: "b" } },
    ],
  };
  const a = sample(circuit, 500, 99);
  const b = sample(circuit, 500, 99);
  assert.deepEqual(a.counts, b.counts);
  assert.equal(a.counts["a=0,b=1"], undefined);
  assert.equal(a.counts["a=1,b=0"], undefined);
  assert.equal(a.counts["a=0,b=0"]! + a.counts["a=1,b=1"]!, 500);
});

test("传态多个输入态经修正后恢复 q2", () => {
  for (const input of [
    { alpha: 1, theta: 0 },
    { alpha: Math.SQRT1_2, theta: 0 },
    { alpha: 0.6, theta: Math.PI / 3 },
  ]) {
    const circuit = teleportationCircuit(input.alpha, input.theta);
    const result = exactTree(circuit, { maxBranches: 64, maxSteps: 1000, maxBytes: 1e8 });
    approx(result.totalWeight, 1);
    for (const br of result.branches) {
      let p1 = 0;
      br.amps.forEach((amp, idx) => {
        if (idx & 1) p1 += amp.re * amp.re + amp.im * amp.im;
      });
      approx(p1, 1 - input.alpha * input.alpha, 1e-9);
    }
  }
});

test("SQLite 版本与快照：后续编辑不改旧报告，重启可读取", () => {
  const dir = mkdtempSync(join(tmpdir(), "qsim-"));
  try {
    const svc1 = new SimulationService({ dataDir: dir });
    const v1 = svc1.saveCircuit({
      name: "versioned",
      qubits: 1,
      tolerance: 1e-9,
      version: 1,
      steps: [{ kind: "gate", gate: { type: "H", target: 0 } }],
    });
    const snap = svc1.store.saveSnapshot({
      circuitName: "versioned",
      circuitVersion: v1.version,
      kind: "test",
      algorithmConfig: { seed: 7 },
      payload: { answer: 1 },
    });
    svc1.saveCircuit({
      name: "versioned",
      qubits: 1,
      tolerance: 1e-9,
      version: 1,
      steps: [{ kind: "gate", gate: { type: "X", target: 0 } }],
    });
    svc1.store.close();

    const svc2 = new SimulationService({ dataDir: dir });
    const old = svc2.load("versioned", 1);
    assert.equal(old.steps[0]!.kind === "gate" && old.steps[0]!.gate.type, "H");
    const restored = svc2.store.getSnapshot(snap)!;
    assert.deepEqual(restored.payload, { answer: 1 });
    assert.deepEqual(restored.algorithmConfig, { seed: 7 });
    svc2.store.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("非法初态、非法控制/目标位被拒绝", () => {
  assert.throws(() => new StateVector(13));
  assert.throws(() => new StateVector(2, [c(1)]));
  assert.throws(() => new StateVector(1, [c(1), c(1)]).assertNormalized(1e-9));
  const sv = new StateVector(2);
  assert.throws(() => sv.applyGate({ type: "CX", control: 1, target: 1 }));
  assert.throws(() => sv.applyGate({ type: "CX", control: 5, target: 1 }));
});
