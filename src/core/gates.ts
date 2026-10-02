import type { Complex } from "./complex.ts";
import { c, expI, mul } from "./complex.ts";

/**
 * 量子位编号与计算基约定（公开、固定）：
 * - n 个量子位编号为 0..n-1，0 是最高有效位（MSB / most significant qubit）。
 * - 计算基整数 x 的二进制位 q_k 满足 bit(k) = (x >> (n-1-k)) & 1。
 * - 例如 n=3 时 |010> 的整数是 2：q0=0, q1=1, q2=0。
 * - 状态向量下标即计算基整数，长度必须为 2^n。
 */

export type GateType =
  | "H"
  | "X"
  | "Y"
  | "Z"
  | "S"
  | "T"
  | "P" // 通用相位门 P(phi): diag(1, e^{i phi})
  | "RX"
  | "RY"
  | "RZ"
  | "CX"; // 受控 X（CNOT）

export interface Gate {
  /** 线路内稳定 ID，由创建方分配。 */
  id?: string;
  type: GateType;
  /** 单比特门目标位；CX 时表示目标位。 */
  target: number;
  /** CX 控制位。 */
  control?: number;
  /** P/RX/RY/RZ 的角度参数（弧度）。S=P(pi/2)，T=P(pi/4)。 */
  angle?: number;
  /**
   * 经典控制：仅当经典测量寄存器中 named bit 等于 expected 时执行本门。
   * 为空表示无条件量子门。
   */
  condition?: { bit: string; expected: 0 | 1 };
}

export type Mat2 = [[Complex, Complex], [Complex, Complex]];

const SQRT1_2 = Math.SQRT1_2;

const mat = (
  a: Complex,
  b: Complex,
  d: Complex,
  e: Complex,
): Mat2 => [
  [a, b],
  [d, e],
];

const inv = (z: Complex): Complex => {
  const n = z.re * z.re + z.im * z.im;
  return { re: z.re / n, im: -z.im / n };
};

/** 单比特酉矩阵（计算基 |0>,|1>）。 */
export function matrix2(gate: Gate): Mat2 {
  switch (gate.type) {
    case "H":
      return mat(c(SQRT1_2), c(SQRT1_2), c(SQRT1_2), c(-SQRT1_2));
    case "X":
      return mat(c(0), c(1), c(1), c(0));
    case "Y":
      return mat(c(0), c(0, -1), c(0, 1), c(0));
    case "Z":
      return mat(c(1), c(0), c(0), c(-1));
    case "S":
      return mat(c(1), c(0), c(0), c(0, 1));
    case "T":
      return mat(c(1), c(0), c(0), expI(Math.PI / 4));
    case "P": {
      const phi = gate.angle ?? 0;
      return mat(c(1), c(0), c(0), expI(phi));
    }
    case "RX": {
      const t = (gate.angle ?? 0) / 2;
      return mat(c(Math.cos(t)), c(0, -Math.sin(t)), c(0, -Math.sin(t)), c(Math.cos(t)));
    }
    case "RY": {
      const t = (gate.angle ?? 0) / 2;
      return mat(c(Math.cos(t)), c(-Math.sin(t)), c(Math.sin(t)), c(Math.cos(t)));
    }
    case "RZ": {
      const t = (gate.angle ?? 0) / 2;
      return mat(expI(-t), c(0), c(0), expI(t));
    }
    default:
      throw new Error(`${gate.type} 不是单比特门`);
  }
}

/**
 * 返回任意门的完整稠密矩阵（维度 2^qubits 或 4），用于独立交叉核对，
 * 不用于主状态向量更新路径。CX 矩阵采用控制位为高位、目标位为低位的
 * |cc'> 顺序（c=control 取值，c'=target 取值）。
 */
export function denseMatrix(gate: Gate): Complex[] {
  if (gate.type === "CX") {
    const I = c(1);
    const O = c(0);
    // |00>,|01>,|10>,|11>，control 为第一个下标
    return [I, O, O, O, O, I, O, O, O, O, O, I, O, O, I, O];
  }
  const m = matrix2(gate);
  return [m[0][0], m[0][1], m[1][0], m[1][1]];
}

/** 矩阵乘以向量（稠密，独立参考实现）。 */
export function denseApply(matrix: Complex[], vec: Complex[]): Complex[] {
  const d = matrix.length;
  const side = Math.round(Math.sqrt(d));
  if (side * side !== d || vec.length !== side) {
    throw new Error("稠密矩阵/向量维度不匹配");
  }
  const out: Complex[] = Array.from({ length: side }, () => c(0));
  for (let row = 0; row < side; row++) {
    let acc = c(0);
    for (let col = 0; col < side; col++) {
      acc = {
        re: acc.re + matrix[row * side + col]!.re * vec[col]!.re - matrix[row * side + col]!.im * vec[col]!.im,
        im: acc.im + matrix[row * side + col]!.re * vec[col]!.im + matrix[row * side + col]!.im * vec[col]!.re,
      };
    }
    out[row] = acc;
  }
  return out;
}

/** 用矩阵元逐项乘，辅助测试。 */
export function matMul(a: Complex[], b: Complex[]): Complex[] {
  const side = Math.round(Math.sqrt(a.length));
  const out: Complex[] = Array.from({ length: side * side }, () => c(0));
  for (let i = 0; i < side; i++) {
    for (let j = 0; j < side; j++) {
      let acc = c(0);
      for (let k = 0; k < side; k++) {
        acc = {
          re: acc.re + a[i * side + k]!.re * b[k * side + j]!.re - a[i * side + k]!.im * b[k * side + j]!.im,
          im: acc.im + a[i * side + k]!.re * b[k * side + j]!.im + a[i * side + k]!.im * b[k * side + j]!.re,
        };
      }
      out[i * side + j] = acc;
    }
  }
  return out;
}

export function isUnitary(gate: Gate, tol = 1e-10): boolean {
  const m = gate.type === "CX" ? denseMatrix(gate) : denseMatrix(gate);
  const side = gate.type === "CX" ? 4 : 2;
  for (let i = 0; i < side; i++) {
    for (let j = 0; j < side; j++) {
      let dot: Complex = c(0);
      for (let k = 0; k < side; k++) {
        const conj = { re: m[k * side + i]!.re, im: -m[k * side + i]!.im };
        dot = {
          re: dot.re + conj.re * m[k * side + j]!.re - conj.im * m[k * side + j]!.im,
          im: dot.im + conj.re * m[k * side + j]!.im + conj.im * m[k * side + j]!.re,
        };
      }
      const expected = i === j ? 1 : 0;
      if (Math.abs(dot.re - expected) > tol || Math.abs(dot.im) > tol) return false;
    }
  }
  return true;
}

/** 生成逆门（用于门/逆门测试与构造）。 */
export function inverseGate(gate: Gate): Gate {
  if (gate.type === "CX") return { ...gate };
  const neg = new Set(["P", "RX", "RY", "RZ"]);
  if (neg.has(gate.type)) return { ...gate, angle: -(gate.angle ?? 0) };
  if (gate.type === "S") return { ...gate, type: "P", angle: -Math.PI / 2 };
  if (gate.type === "T") return { ...gate, type: "P", angle: -Math.PI / 4 };
  return { ...gate }; // H,X,Y,Z 自逆
}

export function validateGate(gate: Gate, qubits: number): void {
  if (gate.target < 0 || gate.target >= qubits) {
    throw new Error(`目标位 ${gate.target} 超出 [0,${qubits - 1}]`);
  }
  if (gate.type === "CX") {
    if (gate.control === undefined) throw new Error("CX 必须提供 control");
    if (gate.control < 0 || gate.control >= qubits) {
      throw new Error(`控制位 ${gate.control} 超出 [0,${qubits - 1}]`);
    }
    if (gate.control === gate.target) throw new Error("CX 控制位与目标位不能相同");
  }
  if (["P", "RX", "RY", "RZ"].includes(gate.type) && typeof gate.angle !== "number") {
    throw new Error(`${gate.type} 门必须提供数值 angle（弧度）`);
  }
  if (gate.condition && gate.condition.bit.trim() === "") {
    throw new Error("经典控制条件必须命名经典位");
  }
}

export { mul, inv };
