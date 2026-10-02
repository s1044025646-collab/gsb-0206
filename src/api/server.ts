import { createServer } from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { SimulationService } from "../core/service.ts";

export interface ServerConfig {
  port: number;
  dataDir: string;
}

interface RouteContext {
  body: unknown;
  params: URLSearchParams;
}

export function createApp(config: ServerConfig) {
  const service = new SimulationService({ dataDir: resolve(config.dataDir) });

  const routes: Record<string, (ctx: RouteContext) => unknown> = {
    "GET /health": () => ({ ok: true, maxQubits: 12 }),
    "GET /circuits": () => service.store.listCircuits(),
    "GET /circuit": ({ params }) => service.load(params.get("name")!, params.get("version") ? Number(params.get("version")) : undefined),
    "GET /versions": ({ params }) => service.store.listVersions(params.get("name")!),
    "POST /circuits/import": ({ body }) => service.importCircuit(body),
    "POST /circuits": ({ body }) => service.saveCircuit(body),
    "POST /probabilities": ({ body }) => {
      const req = body as { circuit: unknown; forcedResults?: Record<string, 0 | 1> };
      return service.basisProbabilities(service.importCircuit(req.circuit), req.forcedResults);
    },
    "POST /exact": ({ body }) => {
      const req = body as { circuit: unknown; budget?: Parameters<SimulationService["exact"]>[1] };
      return service.exact(service.importCircuit(req.circuit), req.budget);
    },
    "POST /sample": ({ body }) => {
      const req = body as { circuit: unknown; shots: number; seed: number };
      return service.sampling(service.importCircuit(req.circuit), req.shots, req.seed);
    },
    "POST /expectation": ({ body }) => {
      const req = body as { circuit: unknown; pauli: string; forcedResults?: Record<string, 0 | 1> };
      return service.expectation(service.importCircuit(req.circuit), req.pauli, req.forcedResults);
    },
    "POST /compare": ({ body }) => {
      const req = body as {
        circuitA: unknown;
        circuitB: unknown;
        forcedA?: Record<string, 0 | 1>;
        forcedB?: Record<string, 0 | 1>;
      };
      return service.compare(
        service.importCircuit(req.circuitA),
        service.importCircuit(req.circuitB),
        req.forcedA,
        req.forcedB,
      );
    },
    "POST /export": ({ body, params }) => {
      const req = body as {
        circuit: unknown;
        kind: "state" | "exact" | "samples";
        format: "json" | "csv";
        shots?: number;
        seed?: number;
        forcedResults?: Record<string, 0 | 1>;
      };
      const circuit = service.importCircuit(req.circuit);
      if (req.kind === "exact") return service.exportExact(circuit, req.format);
      if (req.kind === "samples") return service.exportSamples(circuit, req.shots ?? 100, req.seed ?? 1, req.format);
      return service.exportState(circuit, req.format, req.forcedResults);
    },
    "POST /snapshots": ({ body }) => service.snapshot(body as Parameters<SimulationService["snapshot"]>[0]),
    "GET /snapshot": ({ params }) => {
      const id = params.get("id");
      const s = service.store.getSnapshot(Number(id));
      if (!s) throw new Error("快照不存在");
      return s;
    },
    "GET /snapshots": ({ params }) => service.store.listSnapshots(params.get("name") ?? undefined),
  };

  const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    try {
      const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
      const key = `${req.method} ${url.pathname}`;
      const handler = routes[key];
      if (!handler) {
        res.writeHead(404, { "content-type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ error: "未找到 API 路由", route: key }));
        return;
      }
      let body: unknown;
      if (req.method === "POST") {
        const raw = await readBody(req);
        body = raw ? JSON.parse(raw) : {};
      }
      const result = handler({ body, params: url.searchParams });
      const text = typeof result === "string" ? result : JSON.stringify(result, null, 2);
      const isCsv = typeof result === "string" && !text.trimStart().startsWith("{") && !text.trimStart().startsWith("[");
      res.writeHead(200, {
        "content-type": isCsv ? "text/csv; charset=utf-8" : "application/json; charset=utf-8",
      });
      res.end(text);
    } catch (error) {
      res.writeHead(400, { "content-type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({ error: error instanceof Error ? error.message : String(error) }));
    }
  });

  return { server, service };
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolveBody, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk) => chunks.push(chunk as Buffer));
    req.on("end", () => resolveBody(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const port = Number(process.env.PORT ?? process.argv[2] ?? 3000);
  const dataDir = process.env.QSIM_DATA ?? resolve("data");
  const app = createApp({ port, dataDir });
  app.server.listen(port, () => {
    console.log(`量子模拟 API 已启动：http://localhost:${port}`);
    console.log(`SQLite 数据目录：${dataDir}`);
  });
}
