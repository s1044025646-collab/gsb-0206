import { test } from "node:test";
import * as assert from "node:assert/strict";
import { Simulator, indexToLabel, labelToIndex, classicalControlled } from "../src/core/simulator";
import { denseApplyStep } from "../src/core/dense";
import { compareStates } from "../src/core/compare";
import { basisState, applyGateStep } from "../src/core/statevector";
import { GateStep, Circuit } from "../src/core/types";
import { eiph, mul } from "../src/core/complex";

const sim = new Simulator();

test("计算基编号约定：|10> 为索引 2", () => {
  assert.equal(labelToIndex("10"), 2);
  assert.equal(indexToLabel(2, 2), "10");
  assert.equal(indexToLabel(0b101, 3), "101");
});

test("维度/初态/非法控制位校验", () => {
  assert.throws(() => sim.prepare({ name: "x", qubits: 13, steps: [] }));
  assert.throws(() =>
    sim.prepare({ name: "x", qubits: 2, initial: [{ re: 1, im: 0 }], steps: [] }),
  );
  assert.throws(() =>
    sim.prepare({ name: "x", qubits: 2, initial: [{ re: 1, im: 0 }, { re: 1, im: 0 }, { re: 0, im: 0 }, { re: 0, im: 0 }], steps: [] }),
  );
  assert.throws(() =>
    sim.prepare({ name: "x", qubits: 2, steps: [{ kind: "gate", gate: "CNOT", controls: [0], target: 0 }] }),
  );
});

test("门与逆门：H H = I，X X = I，RZ(θ)RZ(-θ)=I", () => {
  const n = 1;
  let psi = basisState(n, 0);
  const h: GateStep = { kind: "gate", gate: "H", target: 0 };
  const x: GateStep = { kind: "gate", gate: "X", target: 0 };
  let v = applyGateStep(applyGateStep(psi, h), h);
  assert.ok(Math.abs(v[0].re - 1) < 1e-12 && Math.abs(v[0].im) < 1e-12);
  v = applyGateStep(applyGateStep(psi, x), x);
  assert.ok(Math.abs(v[0].re - 1) < 1e-12);
  const rz1: GateStep = { kind: "gate", gate: "RZ", target: 0, theta: 0.7 };
  const rz2: GateStep = { kind: "gate", gate: "RZ", target: 0, theta: -0.7 };
  v = applyGateStep(applyGateStep(psi, rz1), rz2);
  // RZ 作用在 |0> 上仅乘整体相位 e^{i0}（θ 相消），应为 1
  assert.ok(Math.abs(v[0].re - 1) < 1e-12 && Math.abs(v[0].im) < 1e-12);
});

test("两次 H 的干涉恢复 |0>", () => {
  const c: Circuit = {
    name: "hh",
    qubits: 1,
    steps: [
      { kind: "gate", gate: "H", target: 0 },
      { kind: "gate", gate: "H", target: 0 },
    ],
  };
  const { state } = sim.runGates(c);
  assert.ok(Math.abs(state[0].re - 1) < 1e-12);
  assert.ok(Math.abs(state[1].re) < 1e-12);
});

test("稠密矩阵独立核对所有门更新", () => {
  const n = 3;
  const start = basisState(n, 0);
  // 先做点扰动得到非平凡态
  let psi = start;
  for (const g of ["H", "X", "Y", "Z", "S", "T", "P", "RX", "RY", "RZ"] as const) {
    const step: GateStep = {
      kind: "gate",
      gate: g,
      target: 1,
      theta: 0.37,
    };
    const fast = applyGateStep(psi, step);
    const dense = denseApplyStep(n, psi, step);
    for (let i = 0; i < fast.length; i++) {
      assert.ok(Math.abs(fast[i].re - dense[i].re) < 1e-10, `${g} re ${i}`);
      assert.ok(Math.abs(fast[i].im - dense[i].im) < 1e-10, `${g} im ${i}`);
    }
    psi = fast;
  }
  const cnot: GateStep = { kind: "gate", gate: "CNOT", controls: [0, 2], target: 1 };
  const cf = applyGateStep(psi, cnot);
  const cd = denseApplyStep(n, psi, cnot);
  for (let i = 0; i < cf.length; i++) {
    assert.ok(Math.abs(cf[i].re - cd[i].re) < 1e-10);
    assert.ok(Math.abs(cf[i].im - cd[i].im) < 1e-10);
  }
});

test("Bell 态相关测量：精确分支概率各 1/2，和为 1", () => {
  const c: Circuit = {
    name: "bell",
    qubits: 2,
    steps: [
      { kind: "gate", gate: "H", target: 0 },
      { kind: "gate", gate: "CNOT", controls: [0], target: 1 },
      { kind: "measure" },
    ],
  };
  const r = sim.runExact(c);
  assert.equal(r.truncated, false);
  assert.ok(Math.abs(r.probabilitySum - 1) < 1e-12);
  const labels = r.branches
    .map((b) => {
      let s = "";
      for (let q = 1; q >= 0; q--) s += b.record[q];
      return s;
    })
    .sort();
  assert.deepEqual(labels, ["00", "11"]);
  for (const b of r.branches) assert.ok(Math.abs(b.weight - 0.5) < 1e-12);

  // 纠缠关联：边际上 q0 与 q1 各半；联合只在 00/11
  const probs = sim.basisProbabilities({ ...c, steps: c.steps.slice(0, 2) });
  const p = Object.fromEntries(probs.map((x) => [x.label, x.probability]));
  assert.ok(Math.abs(p["00"] - 0.5) < 1e-12);
  assert.ok(Math.abs(p["11"] - 0.5) < 1e-12);
});

test("Bell 抽样可复现且只出现 00/11", () => {
  const c: Circuit = {
    name: "bell",
    qubits: 2,
    seed: 42,
    steps: [
      { kind: "gate", gate: "H", target: 0 },
      { kind: "gate", gate: "CNOT", controls: [0], target: 1 },
      { kind: "measure" },
    ],
  };
  const a = sim.sample(c, 500, 42);
  const b = sim.sample(c, 500, 42);
  assert.deepEqual(a.counts, b.counts);
  assert.deepEqual(Object.keys(a.counts).sort(), ["00", "11"]);
  const total = a.counts["00"] + a.counts["11"];
  assert.equal(total, 500);
});

test("中途测量后经典条件修正（简化传态）", () => {
  // q0 数据位(置为 |1>)，q1 辅助。先 Bell 对(q1 与 q0 的处理用简化版)：
  // 直接构造：H q1, CNOT c1->t0 纠缠；再 CNOT q0->q1，H q0，测量 q0,q1，按结果 X/Z 修正 q0...
  // 为清晰测试条件门，做：数据 q0=|1>；测量 q1(寄存器 c，结果必为 0)，条件 equals 0 才对 q0 作用 X。
  const c: Circuit = {
    name: "cond",
    qubits: 2,
    steps: [
      { kind: "gate", gate: "X", target: 0 },
      { kind: "measure", qubits: [1], register: "c" },
      classicalControlled({ gate: "X", target: 0 }, "c", "0"),
      { kind: "measure" },
    ],
  };
  const r = sim.runExact(c);
  // q1 测得 0 -> 对 q0 施加 X：|10> -> |00>
  assert.equal(r.branches.length, 1);
  assert.equal(r.branches[0].record[0], 0);
  assert.equal(r.branches[0].record[1], 0);
  assert.ok(Math.abs(r.branches[0].weight - 1) < 1e-12);
});

test("不可能的后选择被拒绝（零概率）", () => {
  const c: Circuit = {
    name: "impossible",
    qubits: 1,
    steps: [{ kind: "measure", postselect: "1" }], // 初始 |0>，测 1 概率 0
  };
  assert.throws(() => sim.runExact(c), /概率为 0/);
});

test("可能的后选择被接受并归一", () => {
  const c: Circuit = {
    name: "post",
    qubits: 1,
    steps: [
      { kind: "gate", gate: "H", target: 0 },
      { kind: "measure", postselect: "1" },
    ],
  };
  const r = sim.runExact(c);
  assert.equal(r.branches.length, 1);
  assert.ok(Math.abs(r.branches[0].weight - 0.5) < 1e-9);
  assert.ok(Math.abs(r.branches[0].state[1].re - 1) < 1e-9);
});

test("整体相位等价：|+> 与 e^{iφ}|+> 物理等价", () => {
  const c: Circuit = { name: "plus", qubits: 1, steps: [{ kind: "gate", gate: "H", target: 0 }] };
  const a = sim.runGates(c).state;
  const phi = 0.618;
  const b = a.map((z) => mul(z, eiph(phi)));
  const r = compareStates(a, b);
  assert.equal(r.physicallyEquivalent, true);
  assert.ok(Math.abs((r.globalPhase as number) - phi) < 1e-7);
  assert.equal(r.identical, false);
});

test("相对相位被判为不同态：|+> 与 |->", () => {
  const plus = basisState(1, 0).map((_, i) =>
    i === 0 ? { re: 1 / Math.SQRT2, im: 0 } : { re: 1 / Math.SQRT2, im: 0 },
  );
  const minus = [
    { re: 1 / Math.SQRT2, im: 0 },
    { re: -1 / Math.SQRT2, im: 0 },
  ];
  const r = compareStates(plus, minus);
  assert.equal(r.physicallyEquivalent, false);
  assert.ok(Math.abs(r.fidelity - 0) < 1e-9);
});

test("Pauli 期望：|0> 的 <Z>=1，|1> 的 <Z>=-1，|+> 的 <X>=1、<Z>=0", () => {
  const s0 = sim.runGates({ name: "a", qubits: 1, steps: [] }).state;
  // 直接用 expectation
  const { expectation } = require("../src/core/statevector");
  assert.ok(Math.abs(expectation(s0, [{ qubit: 0, pauli: "Z" }]).value - 1) < 1e-12);
  const s1 = applyGateStep(s0, { kind: "gate", gate: "X", target: 0 });
  assert.ok(Math.abs(expectation(s1, [{ qubit: 0, pauli: "Z" }]).value + 1) < 1e-12);
  const sp = applyGateStep(s0, { kind: "gate", gate: "H", target: 0 });
  assert.ok(Math.abs(expectation(sp, [{ qubit: 0, pauli: "X" }]).value - 1) < 1e-12);
  assert.ok(Math.abs(expectation(sp, [{ qubit: 0, pauli: "Z" }]).value) < 1e-12);
});

test("分支权重沿测量树相乘", () => {
  // 两个量子位各做 H 后分别测量，联合四分支各 1/4
  const c: Circuit = {
    name: "iid",
    qubits: 2,
    steps: [
      { kind: "gate", gate: "H", target: 0 },
      { kind: "gate", gate: "H", target: 1 },
      { kind: "measure", qubits: [0], register: "m0" },
      { kind: "measure", qubits: [1], register: "m1" },
    ],
  };
  const r = sim.runExact(c);
  assert.equal(r.branches.length, 4);
  for (const b of r.branches) assert.ok(Math.abs(b.weight - 0.25) < 1e-12);
  assert.ok(Math.abs(r.probabilitySum - 1) < 1e-12);
});
