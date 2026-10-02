import type { Complex } from "./complex.ts";
import { c, abs2, conj } from "./complex.ts";
import type { Gate, Mat2 } from "./gates.ts";
import { matrix2 } from "./gates.ts";

export const MAX_QUBITS = 12;

export interface NormRecord {
  step: number;
  gateId?: string;
  gate: string;
  normBefore: number;
  normAfter: number;
  deviation: number;
}

export interface ClassicalRegister {
  [name: string]: 0 | 1 | undefined;
}

export class StateVector {
  readonly qubits: number;
  amps: Complex[];
  classical: ClassicalRegister = {};

  constructor(qubits: number, amps?: Complex[]) {
    if (!Number.isInteger(qubits) || qubits < 1 || qubits > MAX_QUBITS) {
      throw new Error(`量子位数必须为 1..${MAX_QUBITS} 的整数`);
    }
    this.qubits = qubits;
    const dim = 2 ** qubits;
    if (amps) {
      if (amps.length !== dim) throw new Error(`初态维度必须为 ${dim}`);
      this.amps = amps.map((a) => ({ re: a.re, im: a.im }));
    } else {
      this.amps = Array.from({ length: dim }, () => c(0));
      this.amps[0] = c(1);
    }
  }

  get dimension(): number {
    return this.amps.length;
  }

  norm(): number {
    let sum = 0;
    for (const a of this.amps) sum += abs2(a);
    return sum;
  }

  clone(): StateVector {
    const sv = new StateVector(this.qubits, this.amps);
    sv.classical = { ...this.classical };
    return sv;
  }

  /**
   * 校验归一化，不做静默重归一。
   * 若需要显式归一（仅用于初始化输入），调用 normalize 并会留下痕迹。
   */
  assertNormalized(tol: number): void {
    const n = this.norm();
    if (Math.abs(n - 1) > tol) {
      throw new Error(`状态未归一化：||ψ||²=${n}，偏差 ${Math.abs(n - 1)} 超过容差 ${tol}`);
    }
  }

  /** 仅在明确需要时（例如测量后由概率条件化）使用。 */
  normalize(): number {
    const n = this.norm();
    if (n <= 0) throw new Error("零向量不能归一化");
    const f = 1 / Math.sqrt(n);
    for (const a of this.amps) {
      a.re *= f;
      a.im *= f;
    }
    return n;
  }

  /** 量子位 q 对应在整数下标中的位移：q=0 是 MSB。 */
  private shift(q: number): number {
    return this.qubits - 1 - q;
  }

  private bitAt(x: number, q: number): 0 | 1 {
    return ((x >> this.shift(q)) & 1) as 0 | 1;
  }

  /** 就地应用单比特酉矩阵（自行实现的状态向量更新）。 */
  applySingle(gate: Gate, m?: Mat2): void {
    const u = m ?? matrix2(gate);
    const q = gate.target;
    const sh = this.shift(q);
    const mask = 1 << sh;
    const next = this.amps.map((a) => ({ re: a.re, im: a.im }));
    for (let base = 0; base < this.dimension; base++) {
      if (base & mask) continue;
      const i0 = base; // q 位为 0
      const i1 = base | mask; // q 位为 1
      const a0 = this.amps[i0]!;
      const a1 = this.amps[i1]!;
      next[i0] = {
        re: u[0][0].re * a0.re - u[0][0].im * a0.im + u[0][1].re * a1.re - u[0][1].im * a1.im,
        im: u[0][0].re * a0.im + u[0][0].im * a0.re + u[0][1].re * a1.im + u[0][1].im * a1.re,
      };
      next[i1] = {
        re: u[1][0].re * a0.re - u[1][0].im * a0.im + u[1][1].re * a1.re - u[1][1].im * a1.im,
        im: u[1][0].re * a0.im + u[1][0].im * a0.re + u[1][1].re * a1.im + u[1][1].im * a1.re,
      };
    }
    this.amps = next;
  }

  /** 就地应用 CX：control=1 时翻转 target。 */
  applyCX(gate: Gate): void {
    if (gate.control === undefined) throw new Error("CX 缺少 control");
    if (gate.control === gate.target) throw new Error("CX 控制位与目标位不能相同");
    if (gate.control < 0 || gate.control >= this.qubits || gate.target < 0 || gate.target >= this.qubits) {
      throw new Error("CX 控制位或目标位非法");
    }
    const cm = 1 << this.shift(gate.control);
    const tm = 1 << this.shift(gate.target);
    for (let x = 0; x < this.dimension; x++) {
      if ((x & cm) && (x & tm) === 0) {
        const y = x | tm;
        const tmp = this.amps[x];
        this.amps[x] = this.amps[y]!;
        this.amps[y] = tmp!;
      }
    }
  }

  applyGate(gate: Gate): void {
    if (gate.condition) {
      const v = this.classical[gate.condition.bit];
      if (v === undefined || v !== gate.condition.expected) return;
    }
    if (gate.type === "CX") this.applyCX(gate);
    else this.applySingle(gate);
  }

  /** 计算位 q 取 0/1 的概率（保留纠缠，仅作边缘概率查询）。 */
  bitProbability(q: number): [number, number] {
    const mask = 1 << this.shift(q);
    let p0 = 0;
    for (let x = 0; x < this.dimension; x++) {
      if ((x & mask) === 0) p0 += abs2(this.amps[x]!);
    }
    return [p0, 1 - p0];
  }

  basisProbabilities(): number[] {
    return this.amps.map(abs2);
  }

  /**
   * 测量但不修改状态，返回两个结果概率。
   */
  measureProb(q: number): { p0: number; p1: number } {
    const [p0, p1] = this.bitProbability(q);
    return { p0, p1 };
  }

  /**
   * 投影测量并坍缩：将 q 投影到指定结果，返回条件化前的概率 p。
   * 调用方负责：分支场景保留原状态，抽样场景使用返回的 p 与随机数比较。
   */
  project(q: number, result: 0 | 1): number {
    const mask = 1 << this.shift(q);
    let p = 0;
    for (let x = 0; x < this.dimension; x++) {
      const b = (x & mask) !== 0;
      if ((result === 1) !== b) {
        this.amps[x] = c(0);
      } else {
        p += abs2(this.amps[x]!);
      }
    }
    if (p > 0) {
      const f = 1 / Math.sqrt(p);
      for (const a of this.amps) {
        a.re *= f;
        a.im *= f;
      }
    }
    return p;
  }
}

/** Pauli 字符，"I" 表示该位不作用。字符串顺序与量子位 0..n-1 对齐（MSB 在前）。 */
export type PauliString = string;

/**
 * 计算 Pauli 串期望 <ψ|P|ψ>，返回实期望值及计算依据（每项贡献）。
 */
export function pauliExpectation(
  sv: StateVector,
  pauli: PauliString,
): { expectation: number; basis: string; contributions: Array<{ x: number; y: number; weight: number; phase: string }> } {
  if (pauli.length !== sv.qubits) {
    throw new Error(`Pauli 串长度 ${pauli.length} 必须等于量子位数 ${sv.qubits}`);
  }
  if (!/^[IXYZ]+$/.test(pauli)) throw new Error("Pauli 串只能包含 I,X,Y,Z");
  let re = 0;
  const contributions: Array<{ x: number; y: number; weight: number; phase: string }> = [];
  for (let x = 0; x < sv.dimension; x++) {
    let y = x;
    let sign = 1;
    let nY = 0;
    for (let q = 0; q < sv.qubits; q++) {
      const ch = pauli[q]!;
      if (ch === "I" || ch === "Z") continue;
      const sh = sv.qubits - 1 - q;
      y ^= 1 << sh;
      if (ch === "Y") {
        const b = (x >> sh) & 1;
        sign *= b === 0 ? 1 : -1; // Y|0>=i|1>, Y|1>=-i|0>
        nY++;
      }
    }
    // Z 本征值乘积
    for (let q = 0; q < sv.qubits; q++) {
      if (pauli[q] === "Z" && ((x >> (sv.qubits - 1 - q)) & 1)) sign *= -1;
    }
    const ax = sv.amps[x]!;
    const ay = sv.amps[y]!;
    // <ax| phase |ay>; Y 引入 i^nY
    let vRe = sign * (ax.re * ay.re + ax.im * ay.im);
    let vIm = sign * (ax.re * ay.im - ax.im * ay.re);
    if (nY % 4 === 1) {
      const t = vRe;
      vRe = -vIm;
      vIm = t;
    } else if (nY % 4 === 2) {
      vRe = -vRe;
      vIm = -vIm;
    } else if (nY % 4 === 3) {
      const t = vRe;
      vRe = vIm;
      vIm = -t;
    }
    re += vRe;
    if (Math.abs(vRe) + Math.abs(vIm) > 1e-15) {
      contributions.push({
        x,
        y,
        weight: Number(vRe.toPrecision(12)),
        phase: nY ? `i^${nY}*(${sign})` : `${sign}`,
      });
    }
  }
  return { expectation: re, basis: pauli, contributions };
}

/**
 * 比较两个态：
 * - 先判定逐分量相同；
 * - 再判定是否仅差整体相位（存在单位复数 u 使 a=u b），物理上等价；
 * - 不做任意重归一，范数偏差单独报告。
 */
export function compareStates(
  a: StateVector,
  b: StateVector,
  tol = 1e-9,
): {
  equal: boolean;
  globalPhaseEquivalent: boolean;
  overlap: Complex;
  overlapMagnitude: number;
  normA: number;
  normB: number;
  globalPhase: number;
  maxComponentDiff: number;
} {
  if (a.qubits !== b.qubits) throw new Error("两态量子位数不同，无法比较");
  let overlapRe = 0;
  let overlapIm = 0;
  let maxDiff = 0;
  for (let i = 0; i < a.dimension; i++) {
    const x = a.amps[i]!;
    const y = b.amps[i]!;
    overlapRe += x.re * y.re + x.im * y.im;
    overlapIm += x.im * y.re - x.re * y.im;
    maxDiff = Math.max(maxDiff, Math.hypot(x.re - y.re, x.im - y.im));
  }
  const overlap = c(overlapRe, overlapIm);
  const mag = Math.hypot(overlapRe, overlapIm);
  const nA = a.norm();
  const nB = b.norm();
  const globalPhaseEquivalent = Math.abs(mag - 1) <= tol && Math.abs(nA - 1) <= tol && Math.abs(nB - 1) <= tol;
  return {
    equal: maxDiff <= tol,
    globalPhaseEquivalent,
    overlap,
    overlapMagnitude: mag,
    normA: nA,
    normB: nB,
    globalPhase: Math.atan2(overlapIm, overlapRe),
    maxComponentDiff: maxDiff,
  };
}

/** 可复现的确定性 PRNG（mulberry32），不使用真实随机源。 */
export function seededRng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export { conj };
