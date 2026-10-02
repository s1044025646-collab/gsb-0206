#!/usr/bin/env node
import * as fs from "node:fs";
import * as path from "node:path";
import { ApiService } from "./api/service";
import { Circuit } from "./core/types";

function usage() {
  console.log(`量子线路状态向量模拟器 CLI

用法:
  qsim convention
  qsim import <circuit.json> [--name 名称]
  qsim steps      <circuit.json> [--save 名称]
  qsim exact      <circuit.json> [--save 名称] [--csv]
  qsim sample     <circuit.json> --shots N [--seed S] [--save 名称]
  qsim probabilities <circuit.json> [--csv]
  qsim expectation   <circuit.json> --pauli "Z:0,X:1"
  qsim compare    <a.json> <b.json>
  qsim circuits
  qsim reports    <名称> [--v N]
  qsim report     <快照ID>

环境变量:
  QSIM_DATA   数据目录(默认 ./data)   QSIM_PORT HTTP 端口(默认 8787)
`);
}

function readCircuit(file: string): Circuit {
  const abs = path.resolve(file);
  return JSON.parse(fs.readFileSync(abs, "utf-8")) as Circuit;
}

function arg(args: string[], key: string): string | undefined {
  const i = args.indexOf(key);
  return i >= 0 ? args[i + 1] : undefined;
}

async function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  const dataDir = process.env.QSIM_DATA ?? path.join(process.cwd(), "data");
  const service = new ApiService({ dataDir });
  const out = (x: unknown) => console.log(JSON.stringify(x, null, 2));

  try {
    switch (cmd) {
      case "convention":
        out(service.convention());
        break;
      case "import": {
        const circuit = readCircuit(rest[0]);
        const name = arg(rest, "--name");
        out(service.importCircuit(name ? { ...circuit, name } : circuit, true));
        break;
      }
      case "steps": {
        const circuit = readCircuit(rest[0]);
        const save = arg(rest, "--save");
        out(service.stepThrough(circuit, save ? { name: save } : undefined));
        break;
      }
      case "exact": {
        const circuit = readCircuit(rest[0]);
        const save = arg(rest, "--save");
        const r = service.exactTree(circuit, save ? { name: save } : undefined);
        if (rest.includes("--csv")) console.log(r.csv);
        else {
          const { csv, ...json } = r;
          void csv;
          out(json);
        }
        break;
      }
      case "sample": {
        const circuit = readCircuit(rest[0]);
        const shots = Number(arg(rest, "--shots") ?? 100);
        const seedRaw = arg(rest, "--seed");
        const save = arg(rest, "--save");
        out(service.sample(circuit, shots, seedRaw ? Number(seedRaw) : undefined, save ? { name: save } : undefined));
        break;
      }
      case "probabilities": {
        const circuit = readCircuit(rest[0]);
        const r = service.probabilities(circuit);
        if (rest.includes("--csv")) console.log(r.csv);
        else {
          const { csv, ...json } = r;
          void csv;
          out(json);
        }
        break;
      }
      case "expectation": {
        const circuit = readCircuit(rest[0]);
        const spec = arg(rest, "--pauli") ?? "";
        const terms = spec
          .split(",")
          .filter(Boolean)
          .map((tok) => {
            const [p, q] = tok.split(":");
            return { pauli: p as "X" | "Y" | "Z", qubit: Number(q) };
          });
        out(service.expectation(circuit, terms));
        break;
      }
      case "compare":
        out(service.compare(readCircuit(rest[0]), readCircuit(rest[1])));
        break;
      case "circuits":
        out(service.listCircuits());
        break;
      case "reports": {
        const vRaw = arg(rest, "--v");
        out(service.listSnapshots(rest[0], vRaw ? Number(vRaw) : undefined));
        break;
      }
      case "report":
        out(service.getSnapshot(Number(rest[0])));
        break;
      default:
        usage();
    }
  } finally {
    service.close();
  }
}

main().catch((e) => {
  console.error("错误:", e.message);
  process.exit(1);
});
