import { writeFileSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { c } from "../core/complex.ts";
import type { Circuit } from "../core/circuit.ts";
import { SimulationService } from "../core/service.ts";
import { toJSON } from "../core/export.ts";

/**
 * 3 量子位量子传态：
 * q0=待传送输入态，q1=Alice，q2=Bob。
 * Bell 分配后测量 q0->a、q1->b；根据 a,b 经典控制 X/Z 修正 q2。
 */
export function teleportationCircuit(alpha: number, theta: number): Circuit {
  return {
    name: `teleport-alpha-${alpha.toFixed(2)}-theta-${theta.toFixed(2)}`,
    qubits: 3,
    tolerance: 1e-9,
    version: 1,
    initial: [
      c(alpha),
      c(0),
      c(0),
      c(0),
      c(
        Math.sqrt(Math.max(0, 1 - alpha * alpha)) * Math.cos(theta),
        Math.sqrt(Math.max(0, 1 - alpha * alpha)) * Math.sin(theta),
      ),
      c(0),
      c(0),
      c(0),
    ],
    steps: [
      { kind: "gate", gate: { id: "h-bell", type: "H", target: 1 } },
      { kind: "gate", gate: { id: "cnot-bell", type: "CX", control: 1, target: 2 } },
      { kind: "gate", gate: { id: "cnot-alice", type: "CX", control: 0, target: 1 } },
      { kind: "gate", gate: { id: "h-input", type: "H", target: 0 } },
      { kind: "measure", measurement: { id: "m-a", qubit: 0, store: "a" } },
      { kind: "measure", measurement: { id: "m-b", qubit: 1, store: "b" } },
      { kind: "gate", gate: { id: "correction-x", type: "X", target: 2, condition: { bit: "b", expected: 1 } } },
      { kind: "gate", gate: { id: "correction-z", type: "Z", target: 2, condition: { bit: "a", expected: 1 } } },
    ],
  };
}

export async function runDemo(dataDir: string, reportsDir: string): Promise<void> {
  mkdirSync(reportsDir, { recursive: true });
  const service = new SimulationService({ dataDir });
  const inputs = [
    { label: "zero", alpha: 1, theta: 0 },
    { label: "plus", alpha: Math.SQRT1_2, theta: 0 },
    { label: "general", alpha: 0.6, theta: Math.PI / 3 },
  ];
  const report: Record<string, unknown> = {
    title: "量子传态演示报告（含中途测量与经典控制修正）",
    convention: "q0 MSB；测量 a=q0,b=q1；修正后 q2 应恢复输入态",
    cases: [],
  };

  for (const input of inputs) {
    const circuit = teleportationCircuit(input.alpha, input.theta);
    const saved = service.saveCircuit(circuit);
    const exact = service.exact(circuit);
    // 每个测量分支中 q2 的条件终态都应等于目标态 alpha|0>+beta|1>（可差整体相位）
    const branchChecks = exact.branches.map((br) => {
      const q2Zero = br.amps.filter((_, idx) => (idx & 1) === 0);
      const q2One = br.amps.filter((_, idx) => (idx & 1) === 1);
      const z = q2Zero.reduce((s, a) => s + a.re * a.re + a.im * a.im, 0);
      const o = q2One.reduce((s, a) => s + a.re * a.re + a.im * a.im, 0);
      return {
        outcomes: br.outcomes,
        weight: br.weight,
        q2Probability0: z,
        q2Probability1: o,
      };
    });
    const targetP1 = (1 - input.alpha * input.alpha);
    const sampling = service.sampling(circuit, 2000, 20261002);
    const snapshotId = service.store.saveSnapshot({
      circuitName: circuit.name,
      circuitVersion: saved.version,
      kind: "teleport-demo",
      algorithmConfig: { shots: 2000, seed: 20261002, budget: { maxBranches: 65536 } },
      payload: { exact, branchChecks, sampling, targetP1 },
    });
    (report.cases as unknown[]).push({
      label: input.label,
      input,
      saved,
      snapshotId,
      targetP1,
      exactComplete: exact.complete,
      totalWeight: exact.totalWeight,
      branches: branchChecks,
      sampleCounts: sampling.counts,
    });
  }

  const reportPath = resolve(reportsDir, "teleport-report.json");
  writeFileSync(reportPath, toJSON(report), "utf8");
  console.log(`报告已写入 ${reportPath}`);
  console.log("重启后可用 CLI/API 按 snapshotId 读取原报告；SQLite 中旧版本与快照不可变。");

  const first = (report.cases as Array<{ snapshotId: number }>)[0]!.snapshotId;
  const loaded = service.store.getSnapshot(first)!;
  console.log(`重启读取检查：snapshot ${loaded.id} / ${loaded.circuitName} v${loaded.circuitVersion} / ${loaded.kind}`);
}
