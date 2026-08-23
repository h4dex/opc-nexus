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
  const main = readFileSync(join(process.cwd(), 'src', 'main', 'index.ts'), 'utf8');
  const ipc = readFileSync(join(process.cwd(), 'src', 'main', 'ipc.ts'), 'utf8');
  const hermesEmbeddedWorkbench = readFileSync(
    join(process.cwd(), 'src', 'main', 'services', 'hermesEmbeddedWorkbench.ts'),
    'utf8'
  );
  const hermesI18n = readFileSync(
    join(process.cwd(), 'vendor', 'hermes-agent', 'web', 'src', 'i18n', 'context.tsx'),
    'utf8'
  );
  const hermesApp = readFileSync(
    join(process.cwd(), 'vendor', 'hermes-agent', 'web', 'src', 'App.tsx'),
    'utf8'
  );
  const hermesProjectBar = readFileSync(
    join(process.cwd(), 'vendor', 'hermes-agent', 'web', 'src', 'components', 'NexusProjectBar.tsx'),
    'utf8'
  );
  const workbenchStyles = readFileSync(
    join(rendererRoot, 'pages', 'questWorkbench.css'),
    'utf8'
  );

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

  it('keeps Quest as an embedded first-class route beside the project center', () => {
    expect(app).toContain("{ key: 'quest', label: 'Quest'");
    expect(app).toContain("{ key: 'projects', label: '项目中心'");
    expect(app).toContain("case 'quest': return <Quest active={route === 'quest'} />;");
    expect(app).toContain("if (n.key === 'quest') openQuestShortcut(); else setRoute(n.key);");
    expect(app).toContain('openQuest(project.id);');
    expect(app).toContain('openQuest(null);');
    expect(app).not.toContain('window.aibox.openHermesWorkbench(project.id)');
    expect(app).toContain("title={n.key === 'quest' ? '打开最近项目的 Quest' : undefined}");
  });

  it('opens the project center by default and opens project Quest in the main workspace', () => {
    expect(store).toContain("route: 'projects'");
    expect(projects).not.toContain("from './QuestWorkbench'");
    expect(projects).not.toContain('<QuestWorkbench');
    expect(projects).toContain('openQuest(project.id)');
    expect(projects).toContain('openProjectWorkbench(project)');
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

  it('carries an employee-card launch into a project-scoped Hermes conversation', () => {
    const agents = readFileSync(join(rendererRoot, 'pages', 'Agents.tsx'), 'utf8');
    expect(store).toContain('questEmployeeId: string | null');
    expect(store).toContain('openQuest: (projectId?: string | null, employeeId?: string | null)');
    expect(agents).toContain('title={`选择 ${questAgent.name} 使用的项目`}');
    expect(agents).toContain("fixed.length === 0 || fixed.includes(agent.id)");
    expect(agents).toContain('openQuest(projectId, employeeId)');
    expect(quest).toContain('createHermesProjectConversation(project.id, questEmployeeId)');
    expect(quest).toContain('initialConversationId={launchConversationId}');
    expect(workbench).toContain('conversationId: initialConversationId');
    expect(workbench).toContain("embedPhase !== 'ready'");
    expect(workbench).toContain('initialConversationIdRef.current');
    expect(app).toContain("const KEEP_ALIVE: RouteKey[] = ['quest'];");
    expect(workbench).toContain("if (!active || workbenchLoading");
    expect(workbench).toContain('setEmbeddedHermesWorkbenchVisible(false)');
    expect(hermesEmbeddedWorkbench).toContain("opc-nexus-conversation-change");
    expect(ipc).toContain("aibox:createHermesProjectConversation");
    expect(ipc).toContain("selection.mode === 'restricted' && !selection.workerAgentIds.includes(safeEmployeeId)");
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
    expect(workbench).toContain('<strong>主控制台</strong><small>打开全部功能菜单</small>');
    expect(workbenchStyles).toContain('.quest-context-footer.is-standalone');
  });

  it('reattaches the current Main Quest whenever the standalone owner closes', () => {
    expect(workbench).toContain('window.aibox.onQuestWindowClosed(() => {');
    expect(workbench).not.toContain('projectId === null || projectId === project.id');
  });

  it('keeps Hermes as the only Quest scheduler while retaining project execution controls', () => {
    expect(workbench).toContain('<span>Hermes 调度</span>');
    expect(workbench).not.toContain('selectedOrchestrator');
    expect(workbench).not.toContain('value="direct"');
    expect(workbench).toContain('saveQuestSettings(projectId');
    expect(workbench).toContain('aria-label="Quest 项目上下文"');
    expect(workbench).toContain('aria-label="在独立窗口打开 Quest"');
    expect(workbench).not.toContain('openDshWorkbench(agentId)');
  });

  it('keeps the OPC-Nexus product shell and composes Quest as a left-center-right workspace', () => {
    expect(workbench).not.toContain("document.documentElement.dataset.questFocus = 'true'");
    expect(workbench).toContain('aria-label="Quest 项目与员工上下文"');
    expect(workbench).toContain('className="quest-embedded-column"');
    expect(workbench).toContain('aria-label="项目治理"');
    expect(workbench).toContain('<span>业务入口</span>');
    expect(workbenchStyles).toContain('.quest-context {');
    expect(workbenchStyles).toContain('.quest-workbench.is-standalone {');
    expect(workbenchStyles).not.toContain("html[data-quest-focus='true'] .app-shell > .sidebar");
  });

  it('uses the host rails around a focused Hermes chat surface on desktop', () => {
    expect(hermesApp).toContain('const embeddedNexusDesktop = nexusProjectMode === "desktop";');
    expect(hermesApp).toContain('const mobileNexusOperator = nexusProjectMode === "mobile-operator";');
    expect(hermesApp).toContain('const showHermesChrome = !embeddedNexusDesktop && !mobileNexusOperator;');
    expect(hermesApp).toContain('{showHermesChrome && <aside');
    expect(hermesApp).toContain('{nexusProjectMode && !embeddedNexusDesktop && <NexusProjectBar />}');
    expect(hermesApp).toContain('embeddedNexusDesktop || mobileNexusOperator ? "p-0"');
  });

  it('makes the project QR a Hermes chat-only mobile surface', () => {
    expect(hermesApp).toContain('window.__OPC_NEXUS_PROJECT_MODE__ ? "/chat" : "/sessions"');
    expect(hermesApp).toContain('if (nexusProjectMode) return { "/": RootRedirect, "/chat": ChatRouteSink };');
    expect(hermesApp).not.toContain('mobile-viewer');
    expect(hermesProjectBar).toContain('data-nexus-mobile-project-bar');
    expect(hermesProjectBar).toContain('__Host-opc_hermes_csrf=');
    expect(hermesProjectBar).not.toContain('__Host-opc_dsh_csrf=');
    expect(hermesProjectBar).not.toContain('Plan v');
  });

  it('applies project model and staffing changes to the Hermes runtime instead of leaving a stale service', () => {
    expect(main).toContain('providerManager.resolveByModel(selectedModel)');
    expect(main).toContain('resolveProviderEnvironment: (projectId)');
    expect(ipc).toContain('const hermesRuntimeConfigChanged');
    expect(ipc).toContain("previous.workerAgentIds.join('\\u0000') !== saved.workerAgentIds.join('\\u0000')");
    expect(ipc).toContain("previous.pluginIds.join('\\u0000') !== saved.pluginIds.join('\\u0000')");
    expect(ipc).not.toContain('await hermesMobile?.stopProject(id)');
    expect(ipc).toContain('await hermesServices.stop(id)');
    expect(workbench).toContain('if (reconnectHermes) setEmbedRevision');
  });

  it('replaces a stale native Hermes frame with an actionable runtime failure state', () => {
    expect(workbench).toContain('window.aibox.getHermesRuntimeStatus(project.id)');
    expect(workbench).toContain("runtime.state !== 'error' && runtime.state !== 'stopped'");
    expect(workbench).toContain('await window.aibox.closeEmbeddedHermesWorkbench()');
    expect(workbench).toContain("setEmbedPhase(runtime.state === 'error' ? 'error' : 'unavailable')");
    expect(workbench).toContain('Hermes 工作区连接失败');
    expect(workbench).toContain('onClick={() => retryEmbed()}');
  });

  it('defaults the integrated Hermes fork to Simplified Chinese', () => {
    expect(hermesI18n).toContain('return "zh";');
  });
});
