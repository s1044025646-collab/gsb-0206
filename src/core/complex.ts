/**
 * 明确的复数数据结构：始终以 { re, im } 表示，不使用隐式编码。
 * 允许通用复数运算，但所有量子语义都在本项目内自行实现。
 */
export interface Complex {
  re: number;
  im: number;
}

export const c = (re: number, im = 0): Complex => ({ re, im });
export const zero = (): Complex => ({ re: 0, im: 0 });
export const clone = (a: Complex): Complex => ({ re: a.re, im: a.im });

export const add = (a: Complex, b: Complex): Complex => ({ re: a.re + b.re, im: a.im + b.im });
export const sub = (a: Complex, b: Complex): Complex => ({ re: a.re - b.re, im: a.im - b.im });
export const mul = (a: Complex, b: Complex): Complex => ({
  re: a.re * b.re - a.im * b.im,
  im: a.re * b.im + a.im * b.re,
});
export const scale = (a: Complex, s: number): Complex => ({ re: a.re * s, im: a.im * s });
export const conj = (a: Complex): Complex => ({ re: a.re, im: -a.im });
export const abs2 = (a: Complex): number => a.re * a.re + a.im * a.im;
export const abs = (a: Complex): number => Math.hypot(a.re, a.im);

/** exp(i * theta) */
export const expI = (theta: number): Complex => ({ re: Math.cos(theta), im: Math.sin(theta) });

export const eq = (a: Complex, b: Complex, tol = 1e-12): boolean =>
  Math.abs(a.re - b.re) <= tol && Math.abs(a.im - b.im) <= tol;

export const format = (a: Complex, digits = 6): string => {
  const r = Number(a.re.toPrecision(digits));
  const i = Number(a.im.toPrecision(digits));
  if (Math.abs(i) < 1e-12) return `${r}`;
  if (Math.abs(r) < 1e-12) return `${i}i`;
  return `${r}${i >= 0 ? "+" : ""}${i}i`;
};
