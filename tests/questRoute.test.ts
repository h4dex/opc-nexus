import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('Quest first-class route source contract', () => {
  const rendererRoot = join(process.cwd(), 'src', 'renderer', 'src');
  const app = readFileSync(join(rendererRoot, 'App.tsx'), 'utf8');
  const projects = readFileSync(join(rendererRoot, 'pages', 'Projects.tsx'), 'utf8');
  const quest = readFileSync(join(rendererRoot, 'pages', 'Quest.tsx'), 'utf8');
  const workbench = readFileSync(join(rendererRoot, 'pages', 'QuestWorkbench.tsx'), 'utf8');
  const store = readFileSync(join(rendererRoot, 'store.ts'), 'utf8');

  it('short-circuits to a standalone Quest product surface without legacy chrome or chat', () => {
    const questSurfaceStart = app.indexOf('if (questSurface) {');
    const legacyShellStart = app.indexOf('<div className="app-shell">', questSurfaceStart);
    const questOnlyBranch = app.slice(questSurfaceStart, legacyShellStart);

    expect(questSurfaceStart).toBeGreaterThan(-1);
    expect(legacyShellStart).toBeGreaterThan(questSurfaceStart);
    expect(questOnlyBranch).toContain('className="quest-only-shell"');
    expect(questOnlyBranch).toContain('<Quest standalone initialProjectId={questSurface.projectId} />');
    expect(questOnlyBranch).not.toContain('className="sidebar"');
    expect(questOnlyBranch).not.toContain('className="topbar"');
    expect(questOnlyBranch).not.toContain('<Chat');
  });

  it('keeps Quest as an independent-window shortcut beside the project center', () => {
    expect(app).toContain("{ key: 'quest', label: 'Quest'");
    expect(app).toContain("{ key: 'projects', label: '项目中心'");
    expect(app).toContain("case 'quest': return <Quest />;");
    expect(app).toContain("if (n.key === 'quest') void openQuestShortcut(); else setRoute(n.key);");
    expect(app).toContain('window.aibox.openQuestWindow({ projectId: project.id })');
    expect(app).toContain("title={n.key === 'quest' ? '在独立窗口打开最近项目' : undefined}");
  });

  it('keeps the regular console as the default and opens project Quest in its own window', () => {
    expect(store).toContain("route: 'dashboard'");
    expect(projects).not.toContain("from './QuestWorkbench'");
    expect(projects).not.toContain('<QuestWorkbench');
    expect(projects).toContain('window.aibox.openQuestWindow({ projectId: project.id })');
    expect(projects).toContain('void openProjectQuest(project)');
    expect(projects).toContain("disabled={project.status === 'archived'}");
  });

  it('selects an explicit project first and provides an empty project state', () => {
    expect(quest).toContain('projects.find((project) => project.id === selectedProjectId)');
    expect(quest).toContain('project={project}');
    expect(quest).toContain('projects={projects}');
    expect(quest).toContain('window.aibox.openQuestWindow({ projectId })');
    expect(quest).toContain('onProjectChange={changeProject}');
    expect(quest).toContain("item.status !== 'archived'");
    expect(quest).toContain('aria-label="Quest 暂无项目"');
    expect(quest).toContain('aria-label="Quest 项目上下文无效"');
  });

  it('keeps the Main window binding in sync when standalone Quest falls back to another project', () => {
    expect(quest).toContain('if (initialProjectId === project.id) return;');
    expect(quest).toContain('void openStandaloneProject(project.id)');
  });

  it('lets standalone Quest bootstrap or recover without returning to the full console', () => {
    expect(quest).toContain("window.aibox.createProject({ name, status: 'active' })");
    expect(quest).toContain('await openStandaloneProject(created.id)');
    expect(quest).toContain('id="quest-recovery-project"');
    expect(quest).toContain('恢复到此项目');
    expect(quest).toContain('创建并打开 Quest');
  });

  it('lets a Quest-only launch restore the regular control center', () => {
    expect(workbench).toContain('window.aibox.openMainSurface()');
    expect(workbench).toContain('aria-label="打开主控制台"');
    expect(workbench).toContain('<IconHome size={15} />');
  });

  it('reattaches the current Main Quest whenever the standalone owner closes', () => {
    expect(workbench).toContain('window.aibox.onQuestWindowClosed(() => {');
    expect(workbench).not.toContain('projectId === null || projectId === project.id');
  });

  it('keeps Quest planning-only while retaining project execution controls', () => {
    expect(workbench).toContain('<strong>Quest</strong>');
    expect(workbench).not.toContain('value="direct"');
    expect(workbench).toContain('saveQuestSettings(projectId');
    expect(workbench).toContain('aria-label="Quest 项目上下文"');
    expect(workbench).toContain('aria-label="在独立窗口打开 Quest"');
    expect(workbench).not.toContain('openDshWorkbench(agentId)');
  });
});
