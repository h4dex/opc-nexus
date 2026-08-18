import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ProjectArtifactManifestService } from '../src/main/services/projectArtifactManifest.js';

const roots: string[] = [];

function workspace(): string {
  const root = mkdtempSync(join(tmpdir(), 'aibox-artifact-manifest-'));
  roots.push(root);
  return root;
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('ProjectArtifactManifestService', () => {
  it('hashes real files changed during a project task and excludes dependency trees', async () => {
    const root = workspace();
    const startedAt = Date.now() - 1_000;
    mkdirSync(join(root, 'src'));
    mkdirSync(join(root, 'node_modules', 'ignored'), { recursive: true });
    writeFileSync(join(root, 'src', 'index.ts'), 'export const ready = true;\n');
    writeFileSync(join(root, 'README.md'), '# Start\n\n`npm run dev`\n');
    writeFileSync(join(root, 'node_modules', 'ignored', 'index.js'), 'not an artifact');
    const audit = vi.fn();
    const service = new ProjectArtifactManifestService({
      getProjectRoot: (projectId) => projectId === 'project-1' ? root : null,
      now: () => 42,
      audit
    });

    const result = await service.validateTaskCompletion({
      taskId: 'task-1', projectId: 'project-1', startedAt, endedAt: Date.now() + 100
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.manifest).toMatchObject({
      schemaVersion: 1,
      projectId: 'project-1',
      sourceTaskId: 'task-1',
      generatedAt: 42,
      truncated: false,
      validation: { status: 'verified', reason: null }
    });
    expect(result.manifest.entries.map((entry) => entry.relativePath)).toEqual(['README.md', 'src/index.ts']);
    expect(result.manifest.entries[0]).toMatchObject({
      mediaType: 'text/markdown',
      sourceTaskId: 'task-1',
      version: 1,
      validationState: 'verified',
      previewKind: 'markdown',
      previewable: true,
      run: null
    });
    expect(result.manifest.entries[1]?.sha256).toBe(
      createHash('sha256').update('export const ready = true;\n').digest('hex')
    );
    expect(audit).toHaveBeenCalledWith(expect.objectContaining({ result: 'verified', detail: '2 files' }));
  });

  it('rejects executor success when no file was produced during the task window', async () => {
    const root = workspace();
    writeFileSync(join(root, 'old.md'), '# Existing');
    const future = Date.now() + 60_000;
    const service = new ProjectArtifactManifestService({ getProjectRoot: () => root });

    await expect(service.validateTaskCompletion({
      taskId: 'task-empty', projectId: 'project-1', startedAt: future, endedAt: future + 1_000
    })).resolves.toEqual(expect.objectContaining({
      ok: false,
      error: expect.stringContaining('未检测到任务期间写入项目目录的真实产物')
    }));
  });

  it('fails closed when the project workspace is not configured', async () => {
    const service = new ProjectArtifactManifestService({ getProjectRoot: () => null });
    await expect(service.validateTaskCompletion({
      taskId: 'task-1', projectId: 'project-1', startedAt: 1, endedAt: 2
    })).resolves.toEqual({ ok: false, error: expect.stringContaining('尚未配置工作目录') });
  });
});
