import {
  Complex,
  ONE,
  ZERO,
  add,
  mul,
  scale,
  abs2,
  conj,
  eiph,
} from "./complex";
import { GateStep, GateType } from "./types";

export type StateVector = Complex[];

export function normSquared(psi: StateVector): number {
  let s = 0;
  for (const a of psi) s += abs2(a);
  return s;
}

export function norm(psi: StateVector): number {
  return Math.sqrt(normSquared(psi));
}

/** 校验维度并归一化；返回归一化后的副本与原始范数。不掩盖错误，仅做初态归一。 */
export function normalize(psi: StateVector, tol: number): { vec: StateVector; originalNorm: number } {
  const n = norm(psi);
  if (n < tol) throw new Error("状态向量为零向量，无法归一化");
  const vec = psi.map((a) => scale(a, 1 / n));
  return { vec, originalNorm: n };
}

export function basisState(n: number, index: number): StateVector {
  const size = 1 << n;
  if (index < 0 || index >= size) throw new Error(`基态索引 ${index} 超出 2^${n}=${size}`);
  const v: StateVector = new Array(size).fill(0).map(() => ({ ...ZERO }));
  v[index] = { ...ONE };
  return v;
}

/** 返回单量子位 2x2 门矩阵（复数，行主序 [00,01,10,11]）。 */
export function gateMatrix(gate: GateType, theta?: number): Complex[] {
  const t = theta ?? 0;
  switch (gate) {
    case "H":
      return [
        { re: 1 / Math.SQRT2, im: 0 },
        { re: 1 / Math.SQRT2, im: 0 },
        { re: 1 / Math.SQRT2, im: 0 },
        { re: -1 / Math.SQRT2, im: 0 },
      ];
    case "X":
      return [ZERO, ONE, ONE, ZERO].map((x) => ({ ...x }));
    case "Y":
      return [ZERO, { re: 0, im: -1 }, { re: 0, im: 1 }, ZERO].map((x) => ({ ...x }));
    case "Z":
      return [ONE, ZERO, ZERO, { re: -1, im: 0 }].map((x) => ({ ...x }));
    case "S":
      return [ONE, ZERO, ZERO, { re: 0, im: 1 }].map((x) => ({ ...x }));
    case "T":
      return [ONE, ZERO, ZERO, eiph(Math.PI / 4)].map((x) => ({ ...x }));
    case "P":
      return [ONE, ZERO, ZERO, eiph(t)].map((x) => ({ ...x }));
    case "RX": {
      const c0 = Math.cos(t / 2);
      const s = Math.sin(t / 2);
      return [
        { re: c0, im: 0 },
        { re: 0, im: -s },
        { re: 0, im: -s },
        { re: c0, im: 0 },
      ];
    }
    case "RY": {
      const c0 = Math.cos(t / 2);
      const s = Math.sin(t / 2);
      return [
        { re: c0, im: 0 },
        { re: -s, im: 0 },
        { re: s, im: 0 },
        { re: c0, im: 0 },
      ];
    }
    case "RZ": {
      return [eiph(-t / 2), ZERO, ZERO, eiph(t / 2)].map((x) => ({ ...x }));
    }
    default:
      throw new Error(`未知单量子位门: ${gate}`);
  }
}

/** 将一个 2x2 门作用到量子位 q（原地更新副本）。 */
export function applySingleQubit(psi: StateVector, q: number, m: Complex[]): StateVector {
  const out = psi.map((a) => ({ ...a }));
  const bit = 1 << q;
  for (let i = 0; i < psi.length; i++) {
    if (i & bit) continue; // 只处理 q=0 的配对
    const i0 = i;
    const i1 = i | bit;
    const a0 = psi[i0];
    const a1 = psi[i1];
    out[i0] = add(mul(m[0], a0), mul(m[1], a1));
    out[i1] = add(mul(m[2], a0), mul(m[3], a1));
  }
  return out;
}

/** 受控 X（CNOT，可多控制位）。 */
export function applyControlledX(psi: StateVector, controls: number[], target: number): StateVector {
  const out = psi.map((a) => ({ ...a }));
  const cmask = controls.reduce((acc, q) => acc | (1 << q), 0);
  const tbit = 1 << target;
  for (let i = 0; i < psi.length; i++) {
    if ((i & cmask) === cmask && (i & tbit) === 0) {
      const j = i | tbit;
      out[i] = { ...psi[j] };
      out[j] = { ...psi[i] };
    }
  }
  return out;
}

export function applyGateStep(psi: StateVector, step: GateStep): StateVector {
  if (step.gate === "CNOT") {
    const controls = step.controls ?? [];
    if (controls.length === 0) throw new Error("CNOT 至少需要一个控制位");
    if (step.target === undefined) throw new Error("CNOT 需要目标位");
    return applyControlledX(psi, controls, step.target);
  }
  if (step.target === undefined) throw new Error(`门 ${step.gate} 需要目标位`);
  return applySingleQubit(psi, step.target, gateMatrix(step.gate, step.theta));
}

/** 计算基各索引概率。 */
export function probabilities(psi: StateVector): number[] {
  return psi.map((a) => abs2(a));
}

export type Pauli = "X" | "Y" | "Z" | "I";

const pauliMat: Record<Exclude<Pauli, "I">, Complex[]> = {
  X: gateMatrix("X"),
  Y: gateMatrix("Y"),
  Z: gateMatrix("Z"),
};

/**
 * 指定 Pauli 串（按量子位给出，如 [{qubit:0,pauli:'X'},{qubit:1,pauli:'Z'}]，其余为 I）
 * 的期望值 <psi|P|psi>，实数。同时返回逐项 <psi|P|psi> 的计算依据。
 */
export function expectation(
  psi: StateVector,
  terms: { qubit: number; pauli: Exclude<Pauli, "I"> }[],
): { value: number; realParts: { index: number; contribution: number }[] } {
  const nQs = Math.round(Math.log2(psi.length));
  const acted: StateVector = psi.map((a) => ({ ...a }));
  // 依次作用各非平凡 Pauli（彼此可对易与否不影响，直接矩阵作用即可；单量子位 Pauli 作用到各自位）
  let v = acted;
  for (const { qubit, pauli } of terms) {
    v = applySingleQubit(v, qubit, pauliMat[pauli]);
  }
  let value = 0;
  const realParts: { index: number; contribution: number }[] = [];
  for (let i = 0; i < psi.length; i++) {
    const contribution = mul(conj(psi[i]), v[i]).re;
    realParts.push({ index: i, contribution });
    value += contribution;
  }
  void nQs;
  return { value, realParts };
}
