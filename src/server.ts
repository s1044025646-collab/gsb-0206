import * as http from "node:http";
import { ApiService } from "./api/service";
import { Circuit } from "./core/types";

export function createServer(service: ApiService) {
  const server = http.createServer((req, res) => {
    const send = (code: number, body: unknown) => {
      res.writeHead(code, { "Content-Type": "application/json; charset=utf-8" });
      res.end(JSON.stringify(body, null, 2));
    };
    const readBody = (): Promise<any> =>
      new Promise((resolve, reject) => {
        let data = "";
        req.on("data", (c) => (data += c));
        req.on("end", () => {
          try {
            resolve(data ? JSON.parse(data) : {});
          } catch (e) {
            reject(e);
          }
        });
        req.on("error", reject);
      });

    const url = new URL(req.url ?? "/", "http://localhost");
    const path = url.pathname;
    const method = req.method ?? "GET";

    (async () => {
      if (method === "GET" && path === "/health") return send(200, { ok: true });
      if (method === "GET" && path === "/convention") return send(200, service.convention());
      if (method === "GET" && path === "/circuits") return send(200, service.listCircuits());

      if (method === "POST" && path === "/circuits") {
        const body = await readBody();
        return send(201, service.importCircuit(body.circuit as Circuit, body.persist !== false));
      }
      if (method === "GET" && path.startsWith("/circuits/")) {
        const rest = decodeURIComponent(path.slice("/circuits/".length));
        const [name, ver] = rest.split("/v");
        return send(200, service.loadCircuit(name, ver ? Number(ver) : undefined));
      }
      if (method === "POST" && path === "/steps") {
        const body = await readBody();
        return send(200, service.stepThrough(body.circuit, body.saveAs));
      }
      if (method === "POST" && path === "/exact") {
        const body = await readBody();
        return send(200, service.exactTree(body.circuit, body.saveAs));
      }
      if (method === "POST" && path === "/sample") {
        const body = await readBody();
        return send(200, service.sample(body.circuit, Number(body.shots ?? 100), body.seed, body.saveAs));
      }
      if (method === "POST" && path === "/probabilities") {
        const body = await readBody();
        return send(200, service.probabilities(body.circuit));
      }
      if (method === "POST" && path === "/expectation") {
        const body = await readBody();
        return send(200, service.expectation(body.circuit, body.terms ?? []));
      }
      if (method === "POST" && path === "/compare") {
        const body = await readBody();
        return send(200, service.compare(body.circuitA, body.circuitB));
      }
      if (method === "GET" && path.startsWith("/snapshots/")) {
        const id = Number(path.slice("/snapshots/".length));
        return send(200, service.getSnapshot(id));
      }
      if (method === "GET" && path.startsWith("/reports/")) {
        const rest = decodeURIComponent(path.slice("/reports/".length));
        const [name, ver] = rest.split("/v");
        return send(200, service.listSnapshots(name, ver ? Number(ver) : undefined));
      }
      send(404, { error: "未找到路由", path });
    })().catch((err) => send(400, { error: String(err && err.message ? err.message : err) }));
  });
  return server;
}

if (require.main === module) {
  const port = Number(process.env.PORT ?? process.env.QSIM_PORT ?? 8787);
  const dataDir = process.env.QSIM_DATA ?? require("node:path").join(process.cwd(), "data");
  const service = new ApiService({ dataDir });
  const server = createServer(service);
  server.listen(port, () => {
    console.log(`量子模拟后端已启动: http://localhost:${port}  数据目录: ${dataDir}`);
  });
}
