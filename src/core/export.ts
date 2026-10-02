import type { Branch } from "./measurement.ts";
import type { StateVector } from "./statevector.ts";

export function toJSON(value: unknown, pretty = true): string {
  return JSON.stringify(value, null, pretty ? 2 : undefined);
}

function csvEscape(v: string | number): string {
  const s = String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/** 基态概率 CSV：index,bits,probability,re,im */
export function statevectorCSV(sv: StateVector): string {
  const rows = ["index,bits,probability,re,im"];
  for (let x = 0; x < sv.dimension; x++) {
    const bits = x.toString(2).padStart(sv.qubits, "0");
    const a = sv.amps[x]!;
    const p = a.re * a.re + a.im * a.im;
    rows.push([x, bits, p, a.re, a.im].map(csvEscape).join(","));
  }
  return rows.join("\n");
}

/** 精确分支 CSV：outcomes,weight,归一后各基态振幅。 */
export function branchesCSV(branches: Branch[], qubits: number): string {
  const ampHeaders: string[] = [];
  for (let x = 0; x < 2 ** qubits; x++) {
    ampHeaders.push(`amp[${x.toString(2).padStart(qubits, "0")}].re`, `amp[${x.toString(2).padStart(qubits, "0")}].im`);
  }
  const rows = [`outcomes,weight,${ampHeaders.join(",")}`];
  for (const br of branches) {
    const vals: Array<string | number> = [
      br.outcomes.map((o) => `${o.bit}=${o.result}`).join("|"),
      br.weight,
    ];
    for (const a of br.amps) vals.push(a.re, a.im);
    rows.push(vals.map(csvEscape).join(","));
  }
  return rows.join("\n");
}

export function samplesCSV(counts: Record<string, number>, shots: number): string {
  const rows = ["outcomes,count,frequency"];
  for (const [key, count] of Object.entries(counts)) {
    rows.push([csvEscape(key), count, count / shots].join(","));
  }
  return rows.join("\n");
}
