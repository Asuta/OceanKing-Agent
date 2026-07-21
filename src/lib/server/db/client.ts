import Database from "better-sqlite3";
import { drizzle, type BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import fs from "node:fs";
import path from "node:path";
import * as schema from "@/lib/server/db/schema";
import { environmentRuntimeDefaults } from "@/lib/server/provider-config";

export type DatabaseHandle = {
  raw: Database.Database;
  orm: BetterSQLite3Database<typeof schema>;
  dataDir: string;
};

type DatabaseInstanceLock = {
  lockPath: string;
  token: string;
};

type DatabaseInstanceLockMetadata = {
  pid: number;
  token: string;
  cwd: string;
  startedAt: string;
};

const createSql = `
CREATE TABLE IF NOT EXISTS workspace_meta (id INTEGER PRIMARY KEY CHECK(id=1), version INTEGER NOT NULL, revision INTEGER NOT NULL, settings_json TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS agents (id TEXT PRIMARY KEY, label TEXT NOT NULL, summary TEXT NOT NULL, instruction TEXT NOT NULL, skills_json TEXT NOT NULL, settings_json TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS rooms (id TEXT PRIMARY KEY, title TEXT NOT NULL, owner_participant_id TEXT, next_seq INTEGER NOT NULL DEFAULT 1, archived_at TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS participants (id TEXT PRIMARY KEY, room_id TEXT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE, kind TEXT NOT NULL, agent_id TEXT REFERENCES agents(id), display_name TEXT NOT NULL, enabled INTEGER NOT NULL, sort_order INTEGER NOT NULL, created_at TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS participants_room_idx ON participants(room_id, sort_order);
CREATE TABLE IF NOT EXISTS room_messages (id TEXT PRIMARY KEY, room_id TEXT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE, seq INTEGER NOT NULL, sender_id TEXT NOT NULL, sender_name TEXT NOT NULL, sender_role TEXT NOT NULL, source TEXT NOT NULL, kind TEXT NOT NULL, status TEXT NOT NULL, content TEXT NOT NULL, final INTEGER NOT NULL, message_key TEXT, created_at TEXT NOT NULL, UNIQUE(room_id,seq), UNIQUE(room_id,message_key));
CREATE INDEX IF NOT EXISTS messages_room_seq_idx ON room_messages(room_id, seq);
CREATE TABLE IF NOT EXISTS attachments (id TEXT PRIMARY KEY, room_id TEXT REFERENCES rooms(id) ON DELETE SET NULL, message_id TEXT REFERENCES room_messages(id) ON DELETE SET NULL, file_name TEXT NOT NULL, mime_type TEXT NOT NULL, byte_size INTEGER NOT NULL, storage_path TEXT NOT NULL, created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS message_receipts (id TEXT PRIMARY KEY, message_id TEXT NOT NULL REFERENCES room_messages(id) ON DELETE CASCADE, agent_participant_id TEXT NOT NULL, created_at TEXT NOT NULL, UNIQUE(message_id,agent_participant_id));
CREATE TABLE IF NOT EXISTS agent_turns (id TEXT PRIMARY KEY, room_id TEXT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE, agent_id TEXT NOT NULL, agent_participant_id TEXT NOT NULL, user_envelope_json TEXT NOT NULL, anchor_message_id TEXT, assistant_content TEXT NOT NULL, system_prompt TEXT NOT NULL DEFAULT '', conversation_json TEXT NOT NULL DEFAULT '[]', emitted_message_ids_json TEXT NOT NULL, status TEXT NOT NULL, model_meta_json TEXT, error TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS turns_room_idx ON agent_turns(room_id, created_at);
CREATE INDEX IF NOT EXISTS turns_agent_idx ON agent_turns(agent_id, created_at);
CREATE TABLE IF NOT EXISTS tool_executions (id TEXT PRIMARY KEY, turn_id TEXT NOT NULL REFERENCES agent_turns(id) ON DELETE CASCADE, name TEXT NOT NULL, input_json TEXT NOT NULL, output_text TEXT NOT NULL, structured_result_json TEXT NOT NULL, status TEXT NOT NULL, duration_ms INTEGER NOT NULL, error TEXT, created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS timeline_events (id TEXT PRIMARY KEY, turn_id TEXT NOT NULL REFERENCES agent_turns(id) ON DELETE CASCADE, ordinal INTEGER NOT NULL, type TEXT NOT NULL, payload_json TEXT NOT NULL, created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS scheduler_states (room_id TEXT PRIMARY KEY REFERENCES rooms(id) ON DELETE CASCADE, status TEXT NOT NULL, next_agent_participant_id TEXT, active_participant_id TEXT, round_count INTEGER NOT NULL, cursor_json TEXT NOT NULL, receipt_revision_json TEXT NOT NULL, rerun_requested INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS agent_sessions (agent_id TEXT PRIMARY KEY REFERENCES agents(id) ON DELETE CASCADE, history_json TEXT NOT NULL, active_turn_id TEXT, updated_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS turn_handoffs (source_turn_id TEXT PRIMARY KEY REFERENCES agent_turns(id) ON DELETE CASCADE, agent_id TEXT NOT NULL, source_room_id TEXT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE, source_participant_id TEXT NOT NULL, cutoff_seq INTEGER NOT NULL, target_room_id TEXT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE, target_turn_id TEXT REFERENCES agent_turns(id) ON DELETE SET NULL, delivery_only INTEGER NOT NULL DEFAULT 0, awaiting_reply INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS handoffs_target_turn_idx ON turn_handoffs(target_turn_id);
CREATE INDEX IF NOT EXISTS handoffs_target_room_idx ON turn_handoffs(agent_id, target_room_id, target_turn_id);
CREATE TABLE IF NOT EXISTS cron_jobs (id TEXT PRIMARY KEY, agent_id TEXT NOT NULL REFERENCES agents(id), room_id TEXT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE, name TEXT NOT NULL, schedule TEXT NOT NULL, timezone TEXT NOT NULL, prompt TEXT NOT NULL, enabled INTEGER NOT NULL, last_run_at TEXT, next_run_at TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS cron_runs (id TEXT PRIMARY KEY, job_id TEXT NOT NULL REFERENCES cron_jobs(id) ON DELETE CASCADE, status TEXT NOT NULL, message_id TEXT, error TEXT, started_at TEXT NOT NULL, finished_at TEXT);
CREATE TABLE IF NOT EXISTS command_dedup (command_id TEXT PRIMARY KEY, created_at TEXT NOT NULL);
`;

function resolveDataDir(explicit?: string): string {
  const configured = explicit ?? process.env.OCEANKING_DATA_DIR ?? ".oceanking";
  return path.isAbsolute(configured)
    ? path.normalize(configured)
    : path.join(/* turbopackIgnore: true */ process.cwd(), configured);
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

function releaseDatabaseInstanceLock(lock: DatabaseInstanceLock): void {
  try {
    const current = JSON.parse(fs.readFileSync(lock.lockPath, "utf8")) as DatabaseInstanceLockMetadata;
    if (current.token === lock.token) fs.unlinkSync(lock.lockPath);
  } catch { /* 陈旧锁会在下次启动时按 PID 自动清理。 */ }
}

export function acquireDatabaseInstanceLock(dataDir: string): () => void {
  fs.mkdirSync(dataDir, { recursive: true });
  const lockPath = path.join(dataDir, ".oceanking-instance.lock");
  const token = crypto.randomUUID();
  const metadata: DatabaseInstanceLockMetadata = { pid: process.pid, token, cwd: process.cwd(), startedAt: new Date().toISOString() };

  for (let attempt = 0; attempt < 3; attempt += 1) {
    const temporaryPath = `${lockPath}.${process.pid}.${token}.tmp`;
    try {
      fs.writeFileSync(temporaryPath, JSON.stringify(metadata), { flag: "wx" });
      fs.linkSync(temporaryPath, lockPath);
      fs.unlinkSync(temporaryPath);
      const lock = { lockPath, token };
      return () => releaseDatabaseInstanceLock(lock);
    } catch (error) {
      try { fs.unlinkSync(temporaryPath); } catch (cleanupError) { if ((cleanupError as NodeJS.ErrnoException).code !== "ENOENT") throw cleanupError; }
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;

      let owner: DatabaseInstanceLockMetadata;
      try {
        owner = JSON.parse(fs.readFileSync(lockPath, "utf8")) as DatabaseInstanceLockMetadata;
      } catch {
        throw new Error(`OceanKing 数据目录锁损坏：${lockPath}。确认没有服务使用该目录后再删除锁文件。`);
      }
      if (owner.pid === process.pid) return () => {};
      if (processIsAlive(owner.pid)) {
        throw new Error(`OceanKing 数据目录已被另一个后端占用（PID ${owner.pid}，工作目录 ${owner.cwd}）：${dataDir}。同时运行多个工作树时，请为每个进程设置不同的 OCEANKING_DATA_DIR。`);
      }
      try { fs.unlinkSync(lockPath); } catch (cleanupError) { if ((cleanupError as NodeJS.ErrnoException).code !== "ENOENT") throw cleanupError; }
    }
  }
  throw new Error(`无法获取 OceanKing 数据目录锁：${lockPath}`);
}

export function createDatabase(explicitDataDir?: string): DatabaseHandle {
  const dataDir = resolveDataDir(explicitDataDir);
  fs.mkdirSync(dataDir, { recursive: true });
  fs.mkdirSync(path.join(dataDir, "uploads"), { recursive: true });
  fs.mkdirSync(path.join(dataDir, "workspaces", "agents"), { recursive: true });
  fs.mkdirSync(path.join(dataDir, "workspaces", "shared"), { recursive: true });
  const raw = new Database(path.join(dataDir, "oceanking.db"));
  raw.pragma("journal_mode = WAL");
  raw.pragma("foreign_keys = ON");
  raw.pragma("busy_timeout = 5000");
  raw.exec(createSql);
  const turnColumns = new Set((raw.prepare("PRAGMA table_info(agent_turns)").all() as Array<{ name: string }>).map((column) => column.name));
  if (!turnColumns.has("system_prompt")) raw.exec("ALTER TABLE agent_turns ADD COLUMN system_prompt TEXT NOT NULL DEFAULT ''");
  if (!turnColumns.has("conversation_json")) raw.exec("ALTER TABLE agent_turns ADD COLUMN conversation_json TEXT NOT NULL DEFAULT '[]'");
  const handoffColumns = new Set((raw.prepare("PRAGMA table_info(turn_handoffs)").all() as Array<{ name: string }>).map((column) => column.name));
  if (!handoffColumns.has("delivery_only")) raw.exec("ALTER TABLE turn_handoffs ADD COLUMN delivery_only INTEGER NOT NULL DEFAULT 0");
  if (!handoffColumns.has("awaiting_reply")) raw.exec("ALTER TABLE turn_handoffs ADD COLUMN awaiting_reply INTEGER NOT NULL DEFAULT 0");
  if (handoffColumns.has("deferred")) {
    raw.exec("UPDATE turn_handoffs SET awaiting_reply=1 WHERE deferred=1");
    raw.exec("ALTER TABLE turn_handoffs DROP COLUMN deferred");
  }
  const environmentDefaults = environmentRuntimeDefaults();
  const defaults = JSON.stringify(environmentDefaults);
  raw.prepare("INSERT OR IGNORE INTO workspace_meta(id,version,revision,settings_json) VALUES(1,0,0,?)").run(defaults);
  if (process.env.OPENAI_MODELS) {
    const row = raw.prepare("SELECT settings_json FROM workspace_meta WHERE id=1").get() as { settings_json: string };
    const persisted = JSON.parse(row.settings_json) as Partial<typeof environmentDefaults>;
    const model = persisted.model && environmentDefaults.availableModels.includes(persisted.model) ? persisted.model : environmentDefaults.model;
    const reconciled = {
      ...environmentDefaults,
      ...persisted,
      apiFormat: environmentDefaults.apiFormat,
      model,
      availableModels: environmentDefaults.availableModels,
      projectContextRoots: persisted.projectContextRoots ?? [],
    };
    raw.prepare("UPDATE workspace_meta SET settings_json=? WHERE id=1").run(JSON.stringify(reconciled));
  }
  return { raw, orm: drizzle(raw, { schema }), dataDir };
}

const globalDb = globalThis as typeof globalThis & {
  __oceanKingDb?: DatabaseHandle;
  __oceanKingDbLockRelease?: () => void;
  __oceanKingDbExitHookRegistered?: boolean;
};

export function getDatabase(): DatabaseHandle {
  if (!globalDb.__oceanKingDb) {
    const dataDir = resolveDataDir();
    const release = acquireDatabaseInstanceLock(dataDir);
    try {
      globalDb.__oceanKingDb = createDatabase(dataDir);
      globalDb.__oceanKingDbLockRelease = release;
      if (!globalDb.__oceanKingDbExitHookRegistered) {
        process.once("exit", () => globalDb.__oceanKingDbLockRelease?.());
        globalDb.__oceanKingDbExitHookRegistered = true;
      }
    } catch (error) {
      release();
      throw error;
    }
  }
  return globalDb.__oceanKingDb;
}

export function resetDatabaseForTests(): void {
  globalDb.__oceanKingDb?.raw.close();
  globalDb.__oceanKingDbLockRelease?.();
  delete globalDb.__oceanKingDb;
  delete globalDb.__oceanKingDbLockRelease;
}
