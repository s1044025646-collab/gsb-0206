import { Branch, indexToLabel } from "./simulator";

export function branchesToCsv(branches: Branch[], n: number): string {
  const header = "label,outcomes,weight,weighted_neg_log10";
  const rows = branches.map((b) => {
    let label = "";
    for (let q = n - 1; q >= 0; q--) label += b.record[q] === undefined ? "*" : b.record[q];
    const outcomes = b.outcomes.join("|");
    const neglog = b.weight > 0 ? -Math.log10(b.weight) : Infinity;
    return `${label},${outcomes},${b.weight},${isFinite(neglog) ? neglog.toFixed(6) : "inf"}`;
  });
  return [header, ...rows].join("\n") + "\n";
}

export function probabilitiesToCsv(rows: { label: string; probability: number }[]): string {
  const header = "label,probability";
  return [header, ...rows.map((r) => `${r.label},${r.probability}`)].join("\n") + "\n";
}

export { indexToLabel };
