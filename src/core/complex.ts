/**
 * 明确的复数数据结构 { re, im } 与复数运算。
 * 不依赖任何量子线路模拟器；仅为基础复数算术。
 */
export interface Complex {
  re: number;
  im: number;
}

export const c = (re: number, im = 0): Complex => ({ re, im });
export const ZERO: Complex = { re: 0, im: 0 };
export const ONE: Complex = { re: 1, im: 0 };
export const I: Complex = { re: 0, im: 1 };

export const add = (a: Complex, b: Complex): Complex => ({ re: a.re + b.re, im: a.im + b.im });
export const sub = (a: Complex, b: Complex): Complex => ({ re: a.re - b.re, im: a.im - b.im });
export const mul = (a: Complex, b: Complex): Complex => ({
  re: a.re * b.re - a.im * b.im,
  im: a.re * b.im + a.im * b.re,
});
export const scale = (a: Complex, s: number): Complex => ({ re: a.re * s, im: a.im * s });
export const conj = (a: Complex): Complex => ({ re: a.re, im: -a.im });
export const abs2 = (a: Complex): number => a.re * a.re + a.im * a.im;
export const abs = (a: Complex): number => Math.sqrt(abs2(a));

export function divide(a: Complex, b: Complex): Complex {
  const d = abs2(b);
  if (d === 0) throw new Error("复数除零");
  return { re: (a.re * b.re + a.im * b.im) / d, im: (a.im * b.re - a.re * b.im) / d };
}

/** 复数幅角（弧度，范围 (-pi, pi]）。 */
export function arg(a: Complex): number {
  return Math.atan2(a.im, a.re);
}

export function exp(a: Complex): Complex {
  const r = Math.exp(a.re);
  return { re: r * Math.cos(a.im), im: r * Math.sin(a.im) };
}

export function eiph(theta: number): Complex {
  // exp(i*theta)
  return { re: Math.cos(theta), im: Math.sin(theta) };
}

export function isClose(a: Complex, b: Complex, tol = 1e-9): boolean {
  return Math.abs(a.re - b.re) <= tol && Math.abs(a.im - b.im) <= tol;
}

/**
 * 计算两个（已归一化）态之间的整体相位因子 phi，使 |b> ~= e^{i phi} |a>。
 * 若二者并非只差整体相位，返回 null。
 */
export function globalPhase(a: Complex[], b: Complex[], tol = 1e-8): number | null {
  let ref = -1;
  for (let k = 0; k < a.length; k++) {
    if (abs2(a[k]) > tol) {
      ref = k;
      break;
    }
  }
  if (ref < 0) return null;
  const phi = arg(divide(b[ref], a[ref]));
  for (let k = 0; k < a.length; k++) {
    const expected = mul(a[k], eiph(phi));
    if (!isClose(expected, b[k], tol * 10)) return null;
  }
  return phi;
}

export function fmtComplex(a: Complex, digits = 6): string {
  const r = Number(a.re.toFixed(digits));
  const i = Number(a.im.toFixed(digits));
  if (i === 0) return `${r}`;
  if (r === 0) return `${i}i`;
  return `${r}${i >= 0 ? "+" : ""}${i}i`;
}
