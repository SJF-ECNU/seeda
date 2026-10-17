import { DatabaseSync } from 'node:sqlite';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, chmod, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';

import { agentOnly, copyAgent, snapshotFiles } from './snapshot.ts';

const exec = promisify(execFile);
export interface SeedOrigin { strain_id: string; strain_name: string; strain_commit: string; }
export interface Version { id: string; parent_id: string | null; git_commit: string; runtime_path: string; reason: string; }
export interface Evaluation { id: string; source_version: string; candidate_version: string; status: string; evidence_path: string; decision: string | null; reason: string | null; }
export class VersionStore {
  readonly root: string;
  readonly repo: string;
  readonly db: DatabaseSync;
  private constructor(root: string, db: DatabaseSync) { this.root = root; this.repo = join(root, 'repository'); this.db = db; }
  static async open(root: string): Promise<VersionStore> {
    root = resolve(root); await mkdir(root, { recursive: true, mode: 0o700 }); await chmod(root, 0o700);
    const db = new DatabaseSync(join(root, 'state.db')); await chmod(join(root, 'state.db'), 0o600);
    db.exec(`PRAGMA busy_timeout=5000; PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL;
      CREATE TABLE IF NOT EXISTS versions(id TEXT PRIMARY KEY,parent_id TEXT REFERENCES versions(id),git_commit TEXT NOT NULL,runtime_path TEXT NOT NULL UNIQUE,reason TEXT NOT NULL,created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
      CREATE TABLE IF NOT EXISTS evaluations(id TEXT PRIMARY KEY,source_version TEXT NOT NULL REFERENCES versions(id),candidate_version TEXT NOT NULL REFERENCES versions(id),status TEXT NOT NULL,evidence_path TEXT NOT NULL,decision TEXT,reason TEXT,created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
      CREATE TABLE IF NOT EXISTS instances(id TEXT PRIMARY KEY,version_id TEXT NOT NULL REFERENCES versions(id),role TEXT NOT NULL,state TEXT NOT NULL,pid INTEGER,reason TEXT,started_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,ended_at TEXT);
      CREATE TABLE IF NOT EXISTS runtime_state(id INTEGER PRIMARY KEY CHECK(id=1),current_version TEXT REFERENCES versions(id),previous_version TEXT REFERENCES versions(id),switch_target TEXT REFERENCES versions(id),phase TEXT NOT NULL DEFAULT 'stopped');
      INSERT OR IGNORE INTO runtime_state(id) VALUES(1);
      CREATE TABLE IF NOT EXISTS switches(id TEXT PRIMARY KEY,from_version TEXT REFERENCES versions(id),to_version TEXT NOT NULL REFERENCES versions(id),kind TEXT NOT NULL,reason TEXT NOT NULL,state TEXT NOT NULL,created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,completed_at TEXT);
      CREATE TABLE IF NOT EXISTS seed_origin(id INTEGER PRIMARY KEY CHECK(id=1),strain_id TEXT NOT NULL,strain_name TEXT NOT NULL,strain_commit TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS session_selection(id INTEGER PRIMARY KEY CHECK(id=1),session TEXT NOT NULL);
      INSERT OR IGNORE INTO session_selection(id,session) VALUES(1,'main');
      CREATE TABLE IF NOT EXISTS drafts(id TEXT PRIMARY KEY,parent_id TEXT NOT NULL REFERENCES versions(id),path TEXT NOT NULL UNIQUE,state TEXT NOT NULL DEFAULT 'editing');`);
    return new VersionStore(root, db);
  }
  origin(): SeedOrigin | undefined { return this.db.prepare('SELECT strain_id,strain_name,strain_commit FROM seed_origin WHERE id=1').get() as unknown as SeedOrigin | undefined; }
  async seed(source: string, origin: SeedOrigin): Promise<Version> {
    if (this.state().current_version) throw new Error('Project already seeded; existing versions are retained');
    const version = await this.initialize(source);
    this.db.prepare('INSERT INTO seed_origin(id,strain_id,strain_name,strain_commit) VALUES(1,?,?,?)').run(origin.strain_id, origin.strain_name, origin.strain_commit);
    return version;
  }
  versions(): Version[] { return this.db.prepare('SELECT * FROM versions ORDER BY created_at,rowid').all() as unknown as Version[]; }
  version(id: string): Version {
    const version = this.db.prepare('SELECT * FROM versions WHERE id=?').get(id) as unknown as Version | undefined;
    if (!version) throw new Error('Unknown version'); return version;
  }
  state(): { current_version: string | null; previous_version: string | null; switch_target: string | null; phase: string } {
    return this.db.prepare('SELECT * FROM runtime_state WHERE id=1').get() as never;
  }
  private async git(...args: string[]): Promise<string> {
    return (await exec('git', ['-C', this.repo, ...args], { maxBuffer: 4_000_000 })).stdout.trim();
  }
  private async install(commit: string, id: string): Promise<string> {
    const path = join(this.root, 'versions', id); await mkdir(join(this.root, 'versions'), { recursive: true });
    await this.git('worktree', 'add', '--detach', path, commit);
    try {
      await exec('npm', ['ci', '--ignore-scripts', '--no-audit', '--no-fund'], { cwd: path, timeout: 120_000, maxBuffer: 1_000_000 });
      return path;
    } catch { await this.git('worktree', 'remove', '--force', path); throw new Error('Version dependency installation failed'); }
  }
  async initialize(source: string): Promise<Version> {
    if (this.versions().length) return this.version(this.state().current_version!);
    await mkdir(this.repo, { recursive: true });
    // Only implementation files; never copy local sessions, environment or credentials.
    await copyAgent(source, this.repo);
    await exec('git', ['init', this.repo]);
    await this.git('add', ...snapshotFiles);
    if (await this.git('diff', '--cached', '--name-only')) await this.git('-c', 'user.name=seeda', '-c', 'user.email=seeda@localhost', 'commit', '-m', 'Initial managed implementation');
    const commit = await this.git('rev-parse', 'HEAD'); const id = randomUUID(); const path = await this.install(commit, id);
    await this.git('update-ref', `refs/seeda/versions/${id}`, commit);
    this.db.prepare('INSERT INTO versions(id,parent_id,git_commit,runtime_path,reason) VALUES(?,NULL,?,?,?)').run(id, commit, path, 'Initial implementation');
    this.db.prepare("UPDATE runtime_state SET current_version=?,phase='stopped' WHERE id=1").run(id);
    return this.version(id);
  }
  async draft(parent: string): Promise<{ id: string; path: string }> {
    const version = this.version(parent);
    if (this.db.prepare("SELECT id FROM drafts WHERE state IN ('editing','submitting')").get()) throw new Error('A candidate editing directory already exists');
    const id = randomUUID(); const path = join(this.root, 'drafts', id); await mkdir(join(this.root, 'drafts'), { recursive: true });
    this.db.prepare('INSERT INTO drafts(id,parent_id,path) VALUES(?,?,?)').run(id, parent, path);
    try { await this.git('worktree', 'add', '--detach', path, version.git_commit); }
    catch (error) { this.db.prepare('DELETE FROM drafts WHERE id=?').run(id); throw error; }
    return { id, path };
  }
  async submit(draftId: string, reason: string): Promise<Version> {
    if (!reason.trim()) throw new Error('Change reason is required');
    const draft = this.db.prepare("SELECT * FROM drafts WHERE id=? AND state='editing'").get(draftId) as { path: string; parent_id: string } | undefined;
    if (!draft) throw new Error('Unknown editing candidate');
    this.db.prepare("UPDATE drafts SET state='submitting' WHERE id=?").run(draftId);
    try {
    const git = async (...args: string[]) => (await exec('git', ['-C', draft.path, ...args])).stdout.trim();
    // Explicit paths exclude accidental local credentials and runtime output.
    await agentOnly(draft.path);
    await git('add', '-u');
    await git('add', ...snapshotFiles);
    if (await git('diff', '--cached', '--name-only')) await git('-c', 'user.name=seeda', '-c', 'user.email=seeda@localhost', 'commit', '-m', reason);
    const commit = await git('rev-parse', 'HEAD');
    if (commit === this.version(draft.parent_id).git_commit) throw new Error('Candidate has no implementation changes');
    const id = randomUUID(); const path = await this.install(commit, id);
    await this.git('update-ref', `refs/seeda/versions/${id}`, commit);
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.db.prepare('INSERT INTO versions(id,parent_id,git_commit,runtime_path,reason) VALUES(?,?,?,?,?)').run(id, draft.parent_id, commit, path, reason);
      this.db.prepare("UPDATE drafts SET state='submitted' WHERE id=?").run(draftId); this.db.exec('COMMIT');
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
    return this.version(id);
    } catch (error) { this.db.prepare("UPDATE drafts SET state='editing' WHERE id=? AND state='submitting'").run(draftId); throw error; }
  }
  evaluation(id: string): Evaluation {
    const row = this.db.prepare('SELECT * FROM evaluations WHERE id=?').get(id) as unknown as Evaluation | undefined;
    if (!row) throw new Error('Unknown evaluation'); return row;
  }
  decision(id: string, source: string, decision: string, reason: string): void {
    const row = this.evaluation(id);
    if (row.source_version !== source || !['accept', 'reject'].includes(decision) || !reason.trim()) throw new Error('Invalid evaluation decision');
    if (decision === 'accept' && row.status !== 'completed') throw new Error('Cannot accept an incomplete evaluation');
    this.db.prepare('UPDATE evaluations SET decision=?,reason=? WHERE id=?').run(decision, reason, id);
  }
  requestSwitch(target: string, kind: string, reason: string): string {
    this.version(target); if (this.state().switch_target) throw new Error('A switch is already pending');
    const id = randomUUID(); this.db.exec('BEGIN IMMEDIATE');
    try {
      this.db.prepare("INSERT INTO switches(id,from_version,to_version,kind,reason,state) VALUES(?,?,?,?,?,'requested')").run(id, this.state().current_version, target, kind, reason);
      this.db.prepare("UPDATE runtime_state SET switch_target=?,phase='switching' WHERE id=1").run(target); this.db.exec('COMMIT');
    } catch (error) { this.db.exec('ROLLBACK'); throw error; } return id;
  }
  finishSwitch(id: string, success: boolean): void {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      if (success) this.db.prepare("UPDATE runtime_state SET previous_version=CASE WHEN current_version=switch_target THEN previous_version ELSE current_version END,current_version=switch_target,switch_target=NULL,phase='running' WHERE id=1").run();
      else this.db.prepare("UPDATE runtime_state SET switch_target=NULL,phase='running' WHERE id=1").run();
      this.db.prepare('UPDATE switches SET state=?,completed_at=CURRENT_TIMESTAMP WHERE id=?').run(success ? 'completed' : 'failed', id); this.db.exec('COMMIT');
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  recover(): void {
    this.db.exec("UPDATE drafts SET state='editing' WHERE state='submitting'; UPDATE evaluations SET status='interrupted' WHERE status='running'; UPDATE switches SET state='interrupted',completed_at=CURRENT_TIMESTAMP WHERE state='requested'; UPDATE runtime_state SET switch_target=NULL,phase='stopped'; UPDATE instances SET state='interrupted',ended_at=CURRENT_TIMESTAMP WHERE ended_at IS NULL;");
  }
  close(): void { this.db.close(); }
}
