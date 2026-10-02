import { Complex, add, mul, ZERO } from "./complex";
import { GateStep } from "./types";
import { StateVector, gateMatrix } from "./statevector";

type CMatrix = Complex[];

function kron(a: CMatrix, da: number, b: CMatrix, db: number): { m: CMatrix; d: number } {
  const d = da * db;
  const m: CMatrix = new Array(d * d).fill(0).map(() => ({ ...ZERO }));
  for (let ia = 0; ia < da; ia++) {
    for (let ja = 0; ja < da; ja++) {
      for (let ib = 0; ib < db; ib++) {
        for (let jb = 0; jb < db; jb++) {
          m[(ia * db + ib) * d + (ja * db + jb)] = mul(a[ia * da + ja], b[ib * db + jb]);
        }
      }
    }
  }
  return { m, d };
}

function identity(d: number): CMatrix {
  const m: CMatrix = new Array(d * d).fill(0).map(() => ({ ...ZERO }));
  for (let i = 0; i < d; i++) m[i * d + i] = { re: 1, im: 0 };
  return m;
}

/** 构造单量子位门的完整 2^n 稠密矩阵（q 位嵌入）。 */
export function fullSingleMatrix(n: number, q: number, g2: CMatrix): CMatrix {
  // 张量积顺序：量子位 n-1 ... 0，克罗内克从高位开始。
  let m: CMatrix = identity(1);
  let d = 1;
  for (let qq = n - 1; qq >= 0; qq--) {
    const factor = qq === q ? g2 : identity(2);
    const r = kron(m, d, factor, 2);
    m = r.m;
    d = r.d;
  }
  return m;
}

/** 构造 CNOT（controls -> target）的完整稠密矩阵（置换）。 */
export function fullCnotMatrix(n: number, controls: number[], target: number): CMatrix {
  const d = 1 << n;
  const m: CMatrix = new Array(d * d).fill(0).map(() => ({ ...ZERO }));
  const cmask = controls.reduce((a, q) => a | (1 << q), 0);
  const tbit = 1 << target;
  for (let col = 0; col < d; col++) {
    const row = (col & cmask) === cmask ? col ^ tbit : col;
    m[row * d + col] = { re: 1, im: 0 };
  }
  return m;
}

export function matVec(m: CMatrix, v: StateVector): StateVector {
  const d = v.length;
  const out: StateVector = new Array(d).fill(0).map(() => ({ ...ZERO }));
  for (let i = 0; i < d; i++) {
    let acc: Complex = { ...ZERO };
    for (let j = 0; j < d; j++) acc = add(acc, mul(m[i * d + j], v[j]));
    out[i] = acc;
  }
  return out;
}

/** 用独立稠密矩阵逐门核对某一步的态更新。 */
export function denseApplyStep(n: number, psi: StateVector, step: GateStep): StateVector {
  if (step.gate === "CNOT") {
    return matVec(fullCnotMatrix(n, step.controls ?? [], step.target as number), psi);
  }
  return matVec(fullSingleMatrix(n, step.target as number, gateMatrix(step.gate, step.theta)), psi);
}
