import { Circuit, GateStep, MeasureStep, DEFAULT_CONFIG } from "./types";
import { Complex, abs2 } from "./complex";

export function validateCircuit(circuit: Circuit): { n: number; size: number } {
  const n = circuit.qubits;
  if (!Number.isInteger(n) || n < 1 || n > 12) {
    throw new Error(`量子位数量必须为 1..12 的整数，收到 ${circuit.qubits}`);
  }
  const size = 1 << n;
  const cfg = DEFAULT_CONFIG;
  const bytes = size * 16;
  if (bytes > cfg.maxMemoryBytes) {
    throw new Error(`状态向量内存估计 ${bytes} 字节超过预算 ${cfg.maxMemoryBytes}`);
  }
  if (circuit.steps.length > cfg.maxSteps) {
    throw new Error(`步数 ${circuit.steps.length} 超过上限 ${cfg.maxSteps}`);
  }
  const checkQ = (q: number | undefined, what: string) => {
    if (q === undefined || !Number.isInteger(q) || q < 0 || q >= n) {
      throw new Error(`${what} 量子位 ${q} 超出范围 [0, ${n - 1}]`);
    }
  };
  for (const [idx, step] of circuit.steps.entries()) {
    if (step.kind === "gate") {
      const g = step as GateStep;
      if (g.gate === "CNOT") {
        if (!g.controls || g.controls.length === 0) throw new Error(`步骤 ${idx}: CNOT 需要控制位`);
        g.controls.forEach((q) => checkQ(q, "控制"));
        checkQ(g.target, "目标");
        if (g.controls.includes(g.target as number)) {
          throw new Error(`步骤 ${idx}: 控制位与目标位不能相同`);
        }
        if (new Set(g.controls).size !== g.controls.length) {
          throw new Error(`步骤 ${idx}: 控制位重复`);
        }
      } else {
        checkQ(g.target, "目标");
        if (["P", "RX", "RY", "RZ"].includes(g.gate) && typeof g.theta !== "number") {
          throw new Error(`步骤 ${idx}: 门 ${g.gate} 需要数值参数 theta（弧度）`);
        }
      }
    } else {
      const m = step as MeasureStep;
      if (m.qubits) {
        m.qubits.forEach((q) => checkQ(q, "测量"));
        if (new Set(m.qubits).size !== m.qubits.length) {
          throw new Error(`步骤 ${idx}: 被测量子位重复`);
        }
      }
      if (m.postselect !== undefined) {
        const qs = m.qubits ?? Array.from({ length: n }, (_, k) => k);
        if (!/^[01]+$/.test(m.postselect) || m.postselect.length !== qs.length) {
          throw new Error(
            `步骤 ${idx}: 后选择位串必须为长度 ${qs.length} 的 0/1 串，收到 "${m.postselect}"`,
          );
        }
      }
    }
  }
  if (circuit.initial) {
    if (circuit.initial.length !== size) {
      throw new Error(`初态维度 ${circuit.initial.length} 与 2^${n}=${size} 不匹配`);
    }
    let s = 0;
    for (const a of circuit.initial as Complex[]) s += abs2(a);
    const normErr = Math.abs(s - 1);
    if (normErr > 1e-6) {
      throw new Error(`初态未归一化：||psi||^2 = ${s}，偏差 ${normErr} 超过 1e-6`);
    }
  }
  return { n, size };
}
