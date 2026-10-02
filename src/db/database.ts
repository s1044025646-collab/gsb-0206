import { DatabaseSync } from "node:sqlite";
import * as fs from "node:fs";
import * as path from "node:path";
import { Circuit } from "../core/types";

export interface CircuitRow {
  id: number;
  name: string;
  version: number;
  qubit_count: number;
  seed: number | null;
  config_json: string;
  circuit_json: string;
  created_at: string;
}

export interface SnapshotRow {
  id: number;
  circuit_id: number;
  version: number;
  kind: string;
  params_json: string;
  result_json: string;
  created_at: string;
}

export class Store {
  readonly db: DatabaseSync;

  constructor(dataDir: string) {
    fs.mkdirSync(dataDir, { recursive: true });
    const file = path.join(dataDir, "qsim.sqlite");
    this.db = new DatabaseSync(file);
    this.db.exec("PRAGMA journal_mode = WAL;");
    this.db.exec("PRAGMA foreign_keys = ON;");
    this.migrate();
  }

  private migrate() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS circuits (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        version INTEGER NOT NULL,
        qubit_count INTEGER NOT NULL,
        seed INTEGER,
        config_json TEXT NOT NULL,
        circuit_json TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE TABLE IF NOT EXISTS snapshots (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        circuit_id INTEGER NOT NULL,
        version INTEGER NOT NULL,
        kind TEXT NOT NULL,
        params_json TEXT NOT NULL,
        result_json TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        FOREIGN KEY(circuit_id) REFERENCES circuits(id)
      );
      CREATE INDEX IF NOT EXISTS idx_circuit_name ON circuits(name, version);
      CREATE INDEX IF NOT EXISTS idx_snap_circuit ON snapshots(circuit_id, version);
    `);
  }

  /** 保存线路为新版本；后续编辑永远产生新版本，旧报告引用旧版本不变。 */
  saveCircuit(circuit: Circuit, config: unknown): { id: number; version: number } {
    const last = this.db
      .prepare("SELECT MAX(version) AS v FROM circuits WHERE name = ?")
      .get(circuit.name) as { v: number | null } | undefined;
    const version = (last?.v ?? 0) + 1;
    const info = this.db
      .prepare(
        `INSERT INTO circuits (name, version, qubit_count, seed, config_json, circuit_json)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(
        circuit.name,
        version,
        circuit.qubits,
        circuit.seed ?? null,
        JSON.stringify(config),
        JSON.stringify(circuit),
      );
    return { id: Number(info.lastInsertRowid), version };
  }

  getCircuitById(id: number): (CircuitRow & { parsed: Circuit }) | null {
    const row = this.db.prepare("SELECT * FROM circuits WHERE id = ?").get(id) as
      | CircuitRow
      | undefined;
    if (!row) return null;
    return { ...row, parsed: JSON.parse(row.circuit_json) as Circuit };
  }

  getCircuitVersion(name: string, version?: number): (CircuitRow & { parsed: Circuit }) | null {
    const row = version
      ? (this.db
          .prepare("SELECT * FROM circuits WHERE name = ? AND version = ?")
          .get(name, version) as CircuitRow | undefined)
      : (this.db
          .prepare("SELECT * FROM circuits WHERE name = ? ORDER BY version DESC LIMIT 1")
          .get(name) as CircuitRow | undefined);
    if (!row) return null;
    return { ...row, parsed: JSON.parse(row.circuit_json) as Circuit };
  }

  listCircuits(): { id: number; name: string; version: number; qubit_count: number; created_at: string }[] {
    return this.db
      .prepare("SELECT id, name, version, qubit_count, created_at FROM circuits ORDER BY id DESC")
      .all() as never;
  }

  saveSnapshot(circuitId: number, version: number, kind: string, params: unknown, result: unknown): number {
    const info = this.db
      .prepare(
        `INSERT INTO snapshots (circuit_id, version, kind, params_json, result_json)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(circuitId, version, kind, JSON.stringify(params), JSON.stringify(result));
    return Number(info.lastInsertRowid);
  }

  getSnapshot(id: number): (SnapshotRow & { result: unknown; params: unknown }) | null {
    const row = this.db.prepare("SELECT * FROM snapshots WHERE id = ?").get(id) as
      | SnapshotRow
      | undefined;
    if (!row) return null;
    return { ...row, params: JSON.parse(row.params_json), result: JSON.parse(row.result_json) };
  }

  listSnapshots(circuitId: number): { id: number; kind: string; version: number; created_at: string }[] {
    return this.db
      .prepare("SELECT id, kind, version, created_at FROM snapshots WHERE circuit_id = ? ORDER BY id DESC")
      .all(circuitId) as never;
  }

  close() {
    this.db.close();
  }
}
