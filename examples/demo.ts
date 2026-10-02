import * as path from "node:path";
import * as fs from "node:fs";
import { ApiService } from "../src/api/service";
import { Circuit, Step } from "../src/core/types";
import { classicalControlled } from "../src/core/simulator";
import { c } from "../src/core/complex";

const dataDir = path.join(process.cwd(), "data");

function buildTeleport(name: string, alpha: { re: number; im: number }, beta: { re: number; im: number }): Circuit {
  const fullInit = new Array(8).fill(0).map(() => c(0, 0));
  fullInit[0] = alpha; // |000>: q0=0
  fullInit[1] = beta; // |001>: q0=1
  const steps: Step[] = [
    { kind: "gate", gate: "H", target: 1 },
    { kind: "gate", gate: "CNOT", controls: [1], target: 2 },
    { kind: "gate", gate: "CNOT", controls: [0], target: 1 },
    { kind: "gate", gate: "H", target: 0 },
    { kind: "measure", qubits: [1, 0], register: "ab" },
    // ab 位串顺序与 qubits [1,0] 一致：首位=b(q1)，次位=a(q0)
    classicalControlled({ gate: "X", target: 2 }, "ab", "10"), // b=1
    classicalControlled({ gate: "X", target: 2 }, "ab", "11"), // b=1
    classicalControlled({ gate: "Z", target: 2 }, "ab", "01"), // a=1
    classicalControlled({ gate: "Z", target: 2 }, "ab", "11"), // a=1
  ];
  return { name, qubits: 3, initial: fullInit, steps, seed: 7 };
}

function main() {
  if (fs.existsSync(path.join(dataDir, "qsim.sqlite"))) {
    fs.rmSync(path.join(dataDir, "qsim.sqlite"), { force: true });
  }
  const service = new ApiService({ dataDir });

  const inputs: { name: string; alpha: { re: number; im: number }; beta: { re: number; im: number } }[] = [
    { name: "tele-0", alpha: c(1, 0), beta: c(0, 0) },
    { name: "tele-1", alpha: c(0, 0), beta: c(1, 0) },
    { name: "tele-plus", alpha: c(1 / Math.SQRT2, 0), beta: c(1 / Math.SQRT2, 0) },
    { name: "tele-i", alpha: c(0.6, 0), beta: c(0, 0.8) }, // 0.36+0.64=1
  ];

  const snapshotIds: Record<string, number> = {};
  for (const inp of inputs) {
    const circuit = buildTeleport(inp.name, inp.alpha, inp.beta);
    const exact = service.exactTree(circuit, { name: inp.name });
    snapshotIds[inp.name] = exact.snapshotId as number;
    // 验证：q2 未被测量，记录中为 "*"；直接从各分支坍缩后的归一态振幅求 q2 边缘概率。
    let p0 = 0;
    let p1 = 0;
    for (const b of exact.branches) {
      let b0 = 0;
      let b1 = 0;
      for (const a of b.amplitudes) {
        const pr = a.re * a.re + a.im * a.im;
        if (a.index & 4) b1 += pr;
        else b0 += pr;
      }
      p0 += b.weight * b0;
      p1 += b.weight * b1;
    }
    const expectP1 = inp.beta.re ** 2 + inp.beta.im ** 2;
    const ok = Math.abs(p1 - expectP1) < 1e-9 && Math.abs(exact.probabilitySum - 1) < 1e-9;
    console.log(
      `[${inp.name}] 分支数=${exact.branchCount} 概率和=${exact.probabilitySum.toFixed(
        10,
      )} P(q2=1)=${p1.toFixed(6)} 期望=${expectP1.toFixed(6)} => ${ok ? "恢复成功 ✅" : "失败 ❌"}`,
    );
  }

  // 抽样可复现
  const circuit = buildTeleport(inputs[2].name, inputs[2].alpha, inputs[2].beta);
  // 修正完成后再测量 q2，验证抽样轨迹上 Bob 量子位恢复为 |+>（q2 各半）。
  const measured: Circuit = {
    ...circuit,
    steps: [...circuit.steps, { kind: "measure", qubits: [2], register: "bob" }],
  };
  const s1 = service.sample(measured, 300, 7);
  const s2 = service.sample(measured, 300, 7);
  console.log("抽样可复现:", JSON.stringify(s1.counts) === JSON.stringify(s2.counts) ? "✅" : "❌");
  const p1sample = Object.entries(s1.counts)
    .filter(([label]) => label[0] === "1")
    .reduce((acc, [, n]) => acc + n, 0);
  console.log(`抽样 P(q2=1)=${p1sample}/300=${(p1sample / 300).toFixed(3)}（理论 0.5）`);

  service.close();

  // 模拟“重启”：新建服务实例，从 SQLite 读取旧报告
  const reopened = new ApiService({ dataDir });
  console.log("\n--- 重启后读取持久化报告 ---");
  for (const name of ["tele-0", "tele-1", "tele-plus", "tele-i"]) {
    const reports = reopened.listSnapshots(name);
    console.log(`${name}: id=${reports.circuit.id} v${reports.circuit.version} 快照=${JSON.stringify(reports.snapshots.map((s) => s.id))}`);
    const snap = reopened.getSnapshot(snapshotIds[name]) as any;
    console.log(`  报告 kind=${snap.kind} version=${snap.version} branchCount=${snap.result.branchCount} truncated=${snap.result.truncated}`);
  }
  reopened.close();
}

main();
