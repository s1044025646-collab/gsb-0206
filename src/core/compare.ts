import { Complex, globalPhase, abs } from "./complex";
import { StateVector } from "./statevector";

export interface CompareResult {
  /** 内积 <a|b>（未配相）。 */
  overlap: Complex;
  /** 保真度 |<a|b>|^2。 */
  fidelity: number;
  /** 若仅差整体相位，给出相位（弧度）；否则为 null。 */
  globalPhase: number | null;
  /** 是否物理等价（含整体相位等价）。 */
  physicallyEquivalent: boolean;
  /** 是否逐分量完全相同（不含配相）。 */
  identical: boolean;
  /** 最大逐分量误差（最优配相后）。 */
  maxAmplitudeError: number;
  relativePhaseNote: string;
}

export function compareStates(a: StateVector, b: StateVector, tol = 1e-8): CompareResult {
  if (a.length !== b.length) throw new Error("态向量维度不一致，无法比较");
  let overlapRe = 0;
  let overlapIm = 0;
  for (let k = 0; k < a.length; k++) {
    // conj(a)*b
    overlapRe += a[k].re * b[k].re + a[k].im * b[k].im;
    overlapIm += a[k].re * b[k].im - a[k].im * b[k].re;
  }
  const overlap: Complex = { re: overlapRe, im: overlapIm };
  const fidelity = overlapRe * overlapRe + overlapIm * overlapIm;
  const phi = globalPhase(a, b, tol);

  let identical = true;
  let maxErr = 0;
  for (let k = 0; k < a.length; k++) {
    const dr = Math.abs(a[k].re - b[k].re);
    const di = Math.abs(a[k].im - b[k].im);
    if (dr > tol || di > tol) identical = false;
    // 配相后误差
    const cos = phi === null ? 1 : Math.cos(-phi);
    const sin = phi === null ? 0 : Math.sin(-phi);
    const adjRe = b[k].re * cos - b[k].im * sin;
    const adjIm = b[k].re * sin + b[k].im * cos;
    maxErr = Math.max(maxErr, Math.abs(a[k].re - adjRe), Math.abs(a[k].im - adjIm));
  }
  const physicallyEquivalent = phi !== null || fidelity >= 1 - tol * 100;
  return {
    overlap,
    fidelity,
    globalPhase: phi,
    physicallyEquivalent,
    identical,
    maxAmplitudeError: maxErr,
    relativePhaseNote:
      phi !== null
        ? `两态仅差整体相位 e^{i ${phi.toExponential(3)}}，物理上等价；整体相位不可观测。`
        : `保真度 ${fidelity.toFixed(10)}，存在相对相位或振幅差异（并非单纯整体相位）。`,
  };
}

export { abs };
