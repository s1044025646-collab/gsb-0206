import { Complex } from "./complex";

/** 支持的门类型。 */
export type GateType =
  | "H"
 | "X"
 | "Y"
 | "Z"
 | "S"
 | "T"
 | "P" // 相位门 P(theta) = diag(1, e^{i theta})
 | "RX"
 | "RY"
 | "RZ"
 | "CNOT"; // 受控 X

/**
 * 线路中的一步。
 * gate 为幺正门；measure 为计算基测量。
 */
export interface GateStep {
  id?: number;
  kind: "gate";
  gate: GateType;
  /** 目标量子位（H/X/Y/Z/S/T/P/RX/RY/RZ 使用）。 */
  target?: number;
  /** 控制量子位（CNOT 使用）。 */
  controls?: number[];
  /** 角度参数（P/RX/RY/RZ 使用，弧度）。 */
  theta?: number;
  /** 经典控制：仅当命名经典寄存器等于给定二进制串时执行该门。 */
  classicalWhen?: { register: string; equals: string };
}

export interface MeasureStep {
  id?: number;
  kind: "measure";
  /** 被测量子位；省略表示测量全部量子位。 */
  qubits?: number[];
  /**
   * 后选择：若给出，则只保留该经典结果分支，零概率时拒绝。
   * 以二进制字符串给出，顺序与 qubits 一致（每个字符 0/1）。
   */
  postselect?: string;
  /**
   * 经典控制：仅当被测量子位的结果满足该条件时，才执行后续受控门。
   * 与后续 gate 步的 classicalIf 配合使用。
   */
  register?: string;
}

export type Step = GateStep | MeasureStep;

export interface Circuit {
  id?: number;
  name: string;
  qubits: number; // 量子位数量 1..12
  /** 初始状态（计算基振幅，长度 2^qubits）；省略表示 |0...0>。 */
  initial?: Complex[];
  steps: Step[];
  seed?: number; // 抽样用固定种子
  version?: number;
  createdAt?: string;
}

/** 位串约定说明。 */
export const BIT_CONVENTION =
  "基态 |b_{n-1}...b_1 b_0> 映射到整数索引，数组索引的最低位(LSB)对应量子位 q0；" +
  "位串字符串最左字符为最高位量子位 q{n-1}。例如 n=2 时 |10> 表示 q1=1,q0=0，索引为 2。";

export interface SimConfig {
  /** 归一化/等价判定容差。 */
  tolerance?: number;
  /** 精确枚举的最大分支数。 */
  maxBranches?: number;
  /** 最大步数防护。 */
  maxSteps?: number;
  /** 单次状态向量允许的最大字节数预算（复数按 16 字节估计）。 */
  maxMemoryBytes?: number;
}

export const DEFAULT_CONFIG: Required<SimConfig> = {
  tolerance: 1e-9,
  maxBranches: 100000,
  maxSteps: 10000,
  maxMemoryBytes: 64 * 1024 * 1024,
};

export interface StepTrace {
  stepIndex: number;
  kind: Step["kind"];
  normBefore: number;
  normAfter: number;
  /** |normAfter - 1|。 */
  normError: number;
  note?: string;
}
