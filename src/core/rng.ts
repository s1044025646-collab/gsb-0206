/**
 * 可复现的确定性伪随机数发生器（mulberry32）。
 * 明确不使用 crypto / Math.random 等不可复现来源。
 */
export class DeterministicRng {
  private state: number;
  readonly seed: number;

  constructor(seed: number) {
    this.seed = seed >>> 0;
    this.state = this.seed;
  }

  /** 返回 [0,1) 的浮点。 */
  next(): number {
    this.state = (this.state + 0x6d2b79f5) >>> 0;
    let t = this.state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  /**
 * 按给定累积分布选择下标。r 落在 [cum[k-1], cum[k]) 选 k。
 */
  choose(cumulative: number[]): number {
    const r = this.next();
    for (let k = 0; k < cumulative.length; k++) {
      if (r < cumulative[k]) return k;
    }
    return cumulative.length - 1;
  }
}
