import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { Circuit } from "./circuit.ts";

/**
 * SQLite 持久化：
 * - circuits 保存命名线路的所有版本；同名编辑生成新版本，旧版本不被覆盖。
 * - results 保存结果快照（JSON），引用 circuit_version；后续编辑不改旧报告。
 */
export class Store {
  db: DatabaseSync;

  constructor(dbPath: string) {
    mkdirSync(dirname(dbPath), { recursive: true });
    this.db = new DatabaseSync(dbPath);
    this.db.exec("PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS circuits (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        version INTEGER NOT NULL,
        definition TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        UNIQUE(name, version)
      );
      CREATE TABLE IF NOT EXISTS result_snapshots (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        circuit_name TEXT NOT NULL,
        circuit_version INTEGER NOT NULL,
        kind TEXT NOT NULL,
        algorithm_config TEXT NOT NULL,
        payload TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE INDEX IF NOT EXISTS idx_results_circuit
        ON result_snapshots(circuit_name, circuit_version);
    `);
  }

  saveCircuit(circuit: Circuit): { id: number; version: number; createdAt: string } {
    const maxRow = this.db
      .prepare("SELECT COALESCE(MAX(version),0) AS v FROM circuits WHERE name=?")
      .get(circuit.name) as { v: number };
    const version = maxRow.v + 1;
    const definition = JSON.stringify({ ...circuit, version });
    const info = this.db
      .prepare("INSERT INTO circuits(name,version,definition) VALUES(?,?,?)")
      .run(circuit.name, version, definition);
    return { id: Number(info.lastInsertRowid), version, createdAt: new Date().toISOString() };
  }

  getCircuit(name: string, version?: number): (Circuit & { id: number; createdAt: string }) | null {
    const row = version
      ? (this.db
          .prepare("SELECT id,definition,created_at FROM circuits WHERE name=? AND version=?")
          .get(name, version) as { id: number; definition: string; created_at: string } | undefined)
      : (this.db
          .prepare("SELECT id,definition,created_at FROM circuits WHERE name=? ORDER BY version DESC LIMIT 1")
          .get(name) as { id: number; definition: string; created_at: string } | undefined);
    if (!row) return null;
    return { ...(JSON.parse(row.definition) as Circuit), id: row.id, createdAt: row.created_at };
  }

  listCircuits(): Array<{ name: string; latestVersion: number; createdAt: string }> {
    return this.db
      .prepare(
        `SELECT name, MAX(version) AS latestVersion, MAX(created_at) AS createdAt
         FROM circuits GROUP BY name ORDER BY name`,
      )
      .all() as Array<{ name: string; latestVersion: number; createdAt: string }>;
  }

  listVersions(name: string): Array<{ version: number; createdAt: string }> {
    return this.db
      .prepare("SELECT version,created_at AS createdAt FROM circuits WHERE name=? ORDER BY version")
      .all(name) as Array<{ version: number; createdAt: string }>;
  }

  saveSnapshot(input: {
    circuitName: string;
    circuitVersion: number;
    kind: string;
    algorithmConfig: unknown;
    payload: unknown;
  }): number {
    const info = this.db
      .prepare(
        `INSERT INTO result_snapshots(circuit_name,circuit_version,kind,algorithm_config,payload)
         VALUES(?,?,?,?,?)`,
      )
      .run(
        input.circuitName,
        input.circuitVersion,
        input.kind,
        JSON.stringify(input.algorithmConfig),
        JSON.stringify(input.payload),
      );
    return Number(info.lastInsertRowid);
  }

  getSnapshot(id: number): {
    id: number;
    circuitName: string;
    circuitVersion: number;
    kind: string;
    algorithmConfig: unknown;
    payload: unknown;
    createdAt: string;
  } | null {
    const row = this.db
      .prepare(
        `SELECT id,circuit_name,circuit_version,kind,algorithm_config,payload,created_at
         FROM result_snapshots WHERE id=?`,
      )
      .get(id) as
      | {
          id: number;
          circuit_name: string;
          circuit_version: number;
          kind: string;
          algorithm_config: string;
          payload: string;
          created_at: string;
        }
      | undefined;
    if (!row) return null;
    return {
      id: row.id,
      circuitName: row.circuit_name,
      circuitVersion: row.circuit_version,
      kind: row.kind,
      algorithmConfig: JSON.parse(row.algorithm_config),
      payload: JSON.parse(row.payload),
      createdAt: row.created_at,
    };
  }

  listSnapshots(name?: string): Array<{ id: number; circuitName: string; circuitVersion: number; kind: string; createdAt: string }> {
    const rows = name
      ? this.db
          .prepare(
            `SELECT id,circuit_name,circuit_version,kind,created_at FROM result_snapshots
             WHERE circuit_name=? ORDER BY id`,
          )
          .all(name)
      : this.db
          .prepare("SELECT id,circuit_name,circuit_version,kind,created_at FROM result_snapshots ORDER BY id")
          .all();
    return (rows as Array<{
      id: number;
      circuit_name: string;
      circuit_version: number;
      kind: string;
      created_at: string;
    }>).map((r) => ({
      id: r.id,
      circuitName: r.circuit_name,
      circuitVersion: r.circuit_version,
      kind: r.kind,
      createdAt: r.created_at,
    }));
  }

  close(): void {
    this.db.close();
  }
}
