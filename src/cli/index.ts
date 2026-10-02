#!/usr/bin/env node
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { SimulationService } from "../core/service.ts";
import { runDemo } from "./demo.ts";
import { createApp } from "../api/server.ts";
import { toJSON } from "../core/export.ts";

const dataDir = process.env.QSIM_DATA ?? resolve("data");
const service = new SimulationService({ dataDir });

function usage(): string {
  return `qsim - 量子线路状态向量模拟 CLI

用法：
  qsim validate <circuit.json>
  qsim save <circuit.json>
  qsim run <circuit.json> [forced=a:0,b:1 ...]
  qsim exact <circuit.json> [--max-branches N --max-steps N --max-bytes N]
  qsim sample <circuit.json> --shots N --seed N
  qsim expectation <circuit.json> --pauli XXI
  qsim compare <a.json> <b.json>
  qsim export <state|exact|samples> <json|csv> <circuit.json> [--shots N --seed N]
  qsim snapshot <id>
  qsim list
  qsim serve [--port 3000]
  qsim demo
`;
}

function parseArgs(argv: string[]): { positional: string[]; flags: Record<string, string> } {
  const positional: string[] = [];
  const flags: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i]!;
    if (token.startsWith("--")) {
      flags[token.slice(2)] = argv[++i] ?? "true";
    } else {
      positional.push(token);
    }
  }
  return { positional, flags };
}

function loadCircuit(path: string) {
  return service.importCircuit(JSON.parse(readFileSync(resolve(path), "utf8")));
}

function parseForced(values: string[]): Record<string, 0 | 1> {
  const out: Record<string, 0 | 1> = {};
  for (const v of values) {
    const [bit, result] = v.split(":");
    if (!bit || (result !== "0" && result !== "1")) throw new Error(`forced 格式应为 name:0|1，实际 ${v}`);
    out[bit] = Number(result) as 0 | 1;
  }
  return out;
}

async function main(): Promise<void> {
  const [command, ...rest] = process.argv.slice(2);
  if (!command || command === "help" || command === "--help") {
    console.log(usage());
    return;
  }
  const args = parseArgs(rest);
  const [p1, p2, p3] = args.positional;

  switch (command) {
    case "validate":
      console.log(toJSON(service.importCircuit(loadCircuit(p1!))));
      break;
    case "save": {
      const saved = service.saveCircuit(loadCircuit(p1!));
      console.log(toJSON(saved));
      break;
    }
    case "run": {
      const forced = parseForced(args.positional.slice(1));
      console.log(toJSON(service.basisProbabilities(loadCircuit(p1!), forced)));
      break;
    }
    case "exact": {
      const budget = {
        maxBranches: args.flags["max-branches"] ? Number(args.flags["max-branches"]) : undefined,
        maxSteps: args.flags["max-steps"] ? Number(args.flags["max-steps"]) : undefined,
        maxBytes: args.flags["max-bytes"] ? Number(args.flags["max-bytes"]) : undefined,
      };
      console.log(toJSON(service.exact(loadCircuit(p1!), budget)));
      break;
    }
    case "sample":
      console.log(
        toJSON(service.sampling(loadCircuit(p1!), Number(args.flags.shots ?? 100), Number(args.flags.seed ?? 1))),
      );
      break;
    case "expectation":
      console.log(toJSON(service.expectation(loadCircuit(p1!), args.flags.pauli ?? p2!)));
      break;
    case "compare":
      console.log(toJSON(service.compare(loadCircuit(p1!), loadCircuit(p2!))));
      break;
    case "export": {
      const [kind, format, path] = [p1 as "state" | "exact" | "samples", p2 as "json" | "csv", p3!];
      const text =
        kind === "exact"
          ? service.exportExact(loadCircuit(path), format)
          : kind === "samples"
            ? service.exportSamples(loadCircuit(path), Number(args.flags.shots ?? 100), Number(args.flags.seed ?? 1), format)
            : service.exportState(loadCircuit(path), format);
      if (args.flags.out) writeFileSync(resolve(args.flags.out), text, "utf8");
      else console.log(text);
      break;
    }
    case "snapshot":
      console.log(toJSON(service.store.getSnapshot(Number(p1))));
      break;
    case "list":
      console.log(toJSON({ circuits: service.store.listCircuits(), snapshots: service.store.listSnapshots() }));
      break;
    case "serve": {
      const port = Number(args.flags.port ?? process.env.PORT ?? 3000);
      const app = createApp({ port, dataDir });
      app.server.listen(port, () => console.log(`API: http://localhost:${port}`));
      break;
    }
    case "demo":
      await runDemo(dataDir, resolve("reports"));
      break;
    default:
      throw new Error(`未知命令：${command}\n\n${usage()}`);
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
