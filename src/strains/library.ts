import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { chmod, mkdir, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import type { VersionStore, Version } from '../versions/store.ts';

const exec = promisify(execFile);
import { agentOnly, copyAgent, snapshotFiles } from '../versions/snapshot.ts';
export interface Introduction { summary: string; improvements: string; scenarios: string; limitations: string; validation: string; }
export function introduction(value: unknown): Introduction {
  if (!value || typeof value !== 'object' || !['summary', 'improvements', 'scenarios', 'limitations', 'validation'].every(key => typeof (value as Record<string, unknown>)[key] === 'string' && String((value as Record<string, unknown>)[key]).trim())) throw new Error('Introduction requires summary, improvements, scenarios, limitations and validation text');
  return Object.fromEntries(['summary', 'improvements', 'scenarios', 'limitations', 'validation'].map(key => [key, String((value as Record<string, unknown>)[key]).trim()])) as unknown as Introduction;
}
export interface Strain { intro?: Introduction | null; is_default?: boolean; id: string; name: string; git_commit: string; path: string; parent_id: string | null; source_project: string | null; source_version: string | null; description: string; }
export class StrainLibrary {
  readonly root: string;
  readonly repo: string;
  readonly db: DatabaseSync;
  private constructor(root: string, db: DatabaseSync) { this.root = root; this.repo = join(root, 'repository'); this.db = db; }
  static async open(root: string): Promise<StrainLibrary> {
    root = resolve(root); await mkdir(root, { recursive: true, mode: 0o700 }); await chmod(root, 0o700);
    const db = new DatabaseSync(join(root, 'catalog.db')); await chmod(join(root, 'catalog.db'), 0o600);
    db.exec(`PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS strains(id TEXT PRIMARY KEY,name TEXT NOT NULL UNIQUE,git_commit TEXT NOT NULL,path TEXT NOT NULL UNIQUE,parent_id TEXT REFERENCES strains(id),source_project TEXT,source_version TEXT,description TEXT NOT NULL,created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
      CREATE TABLE IF NOT EXISTS strain_introductions(strain_id TEXT PRIMARY KEY REFERENCES strains(id),introduction TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS library_settings(id INTEGER PRIMARY KEY CHECK(id=1),default_strain TEXT REFERENCES strains(id));
      INSERT OR IGNORE INTO library_settings(id) VALUES(1);`);
    return new StrainLibrary(root, db);
  }
  private describe(strain: Strain): Strain {
    const row = this.db.prepare('SELECT introduction FROM strain_introductions WHERE strain_id=?').get(strain.id);
    const selected = this.db.prepare('SELECT default_strain FROM library_settings WHERE id=1').get()!.default_strain;
    return { ...strain, intro: row ? JSON.parse(String(row.introduction)) : null, is_default: selected ? strain.id === selected : strain.name === 'origin' };
  }
  list(): Strain[] { return (this.db.prepare('SELECT * FROM strains ORDER BY rowid').all() as unknown as Strain[]).map(strain => this.describe(strain)); }
  defaultStrain(): Strain { const id = this.db.prepare('SELECT default_strain FROM library_settings WHERE id=1').get()!.default_strain; return this.get(id ? String(id) : 'origin'); }
  setDefault(name: string): Strain { const strain = this.get(name); this.db.prepare('UPDATE library_settings SET default_strain=? WHERE id=1').run(strain.id); return this.get(strain.id); }
  get(name: string): Strain {
    const strain = this.db.prepare('SELECT * FROM strains WHERE id=? OR name=?').get(name, name) as unknown as Strain | undefined;
    if (!strain) throw new Error(`Unknown strain: ${name}`); return this.describe(strain);
  }
  private async git(...args: string[]): Promise<string> { return (await exec('git', ['-C', this.repo, ...args], { maxBuffer: 4_000_000 })).stdout.trim(); }
  private async repository(): Promise<void> {
    await mkdir(this.repo, { recursive: true }); await exec('git', ['init', this.repo]);
  }
  private async save(name: string, commit: string, description: string, project: string | null, version: string | null, parent: string | null): Promise<Strain> {
    const id = randomUUID(); const path = join(this.root, 'strains', id);
    await mkdir(join(this.root, 'strains'), { recursive: true, mode: 0o700 });
    await this.git('worktree', 'add', '--detach', path, commit);
    try {
      this.db.prepare('INSERT INTO strains(id,name,git_commit,path,parent_id,source_project,source_version,description) VALUES(?,?,?,?,?,?,?,?)').run(id, name, commit, path, parent, project, version, description);
      return this.get(id);
    } catch (error) { await this.git('worktree', 'remove', '--force', path); throw error; }
  }
  async checkout(strain: Strain): Promise<{ path: string; close: () => Promise<void> }> {
    const path = join(this.root, 'seeding', randomUUID());
    await mkdir(join(this.root, 'seeding'), { recursive: true, mode: 0o700 });
    await this.git('worktree', 'add', '--detach', path, strain.git_commit);
    return { path, close: async () => { await this.git('worktree', 'remove', '--force', path); } };
  }
  async ensureOrigin(source: string): Promise<Strain> {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const existing = this.db.prepare("SELECT id FROM strains WHERE name='origin'").get();
      if (existing) { const strain = this.get(String(existing.id)); this.db.exec('COMMIT'); return strain; }
      await this.repository();
      await copyAgent(source, this.repo);
      await this.git('add', '-u');
      await this.git('add', ...snapshotFiles);
      if (await this.git('diff', '--cached', '--name-only')) await this.git('-c', 'user.name=seeda', '-c', 'user.email=seeda@localhost', 'commit', '-m', 'Origin strain');
      const strain = await this.save('origin', await this.git('rev-parse', 'HEAD'), '通用初始种系', null, null, null);
      this.db.prepare('INSERT INTO strain_introductions(strain_id,introduction) VALUES(?,?)').run(strain.id, JSON.stringify({ summary: '通用初始种系', improvements: '提供基础编码与候选管理起点', scenarios: '本地编码任务与独立项目成长', limitations: '需要 Node.js 24.14+、Git、npm；运行模型需要已有提供商配置', validation: '系统初始实现；具体项目适配与质量需要单独验证' }));
      this.db.exec('COMMIT'); return this.get(strain.id);
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  async publish(name: string, store: VersionStore, version: Version, project: string, profile?: unknown): Promise<Strain> {
    const intro = introduction(profile);
    if (!/^[a-z][a-z0-9-]{0,63}$/.test(name)) throw new Error('Strain name must be 1-64 lowercase letters, digits or hyphens, beginning with a letter');
    this.db.exec('BEGIN IMMEDIATE');
    try {
      if (this.db.prepare('SELECT id FROM strains WHERE name=?').get(name)) throw new Error('Strain name already exists');
      await this.repository();
      await this.git('fetch', store.repo, version.git_commit);
      await this.git('checkout', '--detach', version.git_commit);
      await agentOnly(this.repo);
      await this.git('add', '-u');
      await this.git('add', ...snapshotFiles);
      if (await this.git('diff', '--cached', '--name-only')) await this.git('-c', 'user.name=seeda', '-c', 'user.email=seeda@localhost', 'commit', '-m', `Agent-only strain: ${name}`);
      const origin = store.origin();
      const ancestor = version.parent_id ? this.db.prepare('SELECT id FROM strains WHERE source_project=? AND source_version=?').get(project, version.parent_id) : undefined;
      const parent = ancestor?.id ?? (origin && this.db.prepare('SELECT id FROM strains WHERE id=?').get(origin.strain_id)?.id) ?? null;
      const strain = await this.save(name, await this.git('rev-parse', 'HEAD'), version.reason, project, version.id, parent === null ? null : String(parent));
      this.db.prepare('INSERT INTO strain_introductions(strain_id,introduction) VALUES(?,?)').run(strain.id, JSON.stringify(intro));
      this.db.exec('COMMIT'); return this.get(strain.id);
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  close(): void { this.db.close(); }
}
