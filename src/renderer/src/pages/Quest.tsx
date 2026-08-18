/** Quest 一级入口：项目只是上下文，不是工作台的父路由。 */
import { useEffect, useMemo, useState } from 'react';
import { IconFolder } from '../components/icons';
import { toast } from '../components/Toast';
import { useApp } from '../store';
import type { Project, ProjectStatus } from '@shared/types';
import { QuestWorkbench } from './QuestWorkbench';

const PROJECT_PRIORITY: Record<ProjectStatus, number> = {
  active: 0,
  planning: 1,
  paused: 2,
  completed: 3,
  archived: 4
};

export function selectQuestProject(projects: Project[], selectedProjectId: string | null): Project | null {
  const selected = selectedProjectId
    ? projects.find((project) => project.id === selectedProjectId)
    : undefined;
  if (selected) return selected;

  return [...projects].sort((left, right) => (
    PROJECT_PRIORITY[left.status] - PROJECT_PRIORITY[right.status]
    || right.updatedAt - left.updatedAt
  ))[0] ?? null;
}

export interface QuestProps {
  standalone?: boolean;
  initialProjectId?: string | null;
}

export function Quest({ standalone = false, initialProjectId = null }: QuestProps = {}) {
  const { snapshot, questProjectId, setRoute, openQuest } = useApp();
  const [standaloneSync, setStandaloneSync] = useState<{ projectId: string; error: string | null } | null>(null);
  const [recoveryProjectId, setRecoveryProjectId] = useState('');
  const [newProjectName, setNewProjectName] = useState('');
  const [creatingProject, setCreatingProject] = useState(false);
  const [bootstrapError, setBootstrapError] = useState<string | null>(null);
  const selectedProjectId = standalone ? initialProjectId : questProjectId ?? initialProjectId;
  const projects = useMemo(
    () => (snapshot?.projects ?? []).filter((item) => item.status !== 'archived'),
    [snapshot?.projects]
  );
  const standaloneProjectMissing = standalone && initialProjectId !== null
    && !projects.some((item) => item.id === initialProjectId);
  const project = useMemo(
    () => standaloneProjectMissing ? null : selectQuestProject(projects, selectedProjectId),
    [projects, selectedProjectId, standaloneProjectMissing]
  );
  const recoveryProject = useMemo(
    () => selectQuestProject(projects, recoveryProjectId || null),
    [projects, recoveryProjectId]
  );

  const openStandaloneProject = async (projectId: string): Promise<boolean> => {
    setStandaloneSync({ projectId, error: null });
    try {
      await window.aibox.openQuestWindow({ projectId });
      return true;
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Quest 项目切换失败';
      setStandaloneSync((current) => current?.projectId === projectId
        ? { projectId, error: message }
        : current);
      return false;
    }
  };

  useEffect(() => {
    if (!project) return;
    if (standalone) {
      if (initialProjectId === project.id) return;
      if (creatingProject) return;
      if (standaloneSync?.projectId === project.id) return;
      void openStandaloneProject(project.id);
      return;
    }
    if (questProjectId === project.id) return;
    openQuest(project.id);
  }, [creatingProject, initialProjectId, openQuest, project, questProjectId, standalone, standaloneSync?.projectId]);

  const changeProject = (projectId: string) => {
    if (!standalone) {
      openQuest(projectId);
      return;
    }
    void openStandaloneProject(projectId).then((ok) => {
      if (!ok) toast.err('Quest 项目切换失败');
    });
  };

  const createStandaloneProject = async () => {
    const name = newProjectName.trim();
    if (name.length < 2) {
      setBootstrapError('项目名称至少需要 2 个字符');
      return;
    }
    setCreatingProject(true);
    setBootstrapError(null);
    try {
      const created = await window.aibox.createProject({ name, status: 'active' });
      setNewProjectName('');
      // Snapshot publication and window navigation race during bootstrap. This
      // explicit transition keeps the new project as the standalone owner.
      await openStandaloneProject(created.id);
    } catch (error) {
      setBootstrapError(error instanceof Error ? error.message : '无法创建 Quest 项目');
    } finally {
      setCreatingProject(false);
    }
  };

  if (!snapshot) return null;
  if (standaloneProjectMissing) return (
    <div className="projects-page">
      <div className="project-empty project-ops-empty" aria-label="Quest 项目上下文无效">
        <span><IconFolder size={28} /></span>
        <strong>项目不存在或已归档</strong>
        {projects.length > 0 && (
          <div className="field" style={{ width: 'min(360px, 100%)', margin: 0 }}>
            <label htmlFor="quest-recovery-project">选择可用项目</label>
            <select
              id="quest-recovery-project"
              value={recoveryProject?.id ?? ''}
              onChange={(event) => setRecoveryProjectId(event.target.value)}
              disabled={standaloneSync !== null && standaloneSync.error === null}
            >
              {projects.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
            </select>
          </div>
        )}
        {standaloneSync?.error && <small role="alert">{standaloneSync.error}</small>}
        {projects.length > 0 && recoveryProject && (
          <button
            className="btn small primary"
            type="button"
            disabled={standaloneSync !== null && standaloneSync.error === null}
            onClick={() => void openStandaloneProject(recoveryProject.id)}
          >
            {standaloneSync?.error === null && standaloneSync?.projectId === recoveryProject.id
              ? '正在恢复…'
              : '恢复到此项目'}
          </button>
        )}
        {projects.length === 0 && (
          <StandaloneProjectBootstrap
            name={newProjectName}
            onNameChange={(value) => { setNewProjectName(value); setBootstrapError(null); }}
            onCreate={() => void createStandaloneProject()}
            creating={creatingProject}
            error={bootstrapError}
          />
        )}
      </div>
    </div>
  );
  if (standalone && project && initialProjectId !== project.id) return (
    <div className="projects-page">
      <div className="project-empty project-ops-empty" aria-label="Quest 项目上下文同步">
        <span><IconFolder size={28} /></span>
        <strong>{standaloneSync?.error ?? '正在切换项目上下文'}</strong>
        {standaloneSync?.error && (
          <button className="btn small primary" type="button" onClick={() => setStandaloneSync(null)}>重试</button>
        )}
      </div>
    </div>
  );
  if (project) return (
    <QuestWorkbench
      project={project}
      projects={projects}
      onProjectChange={changeProject}
      onBack={standalone ? undefined : () => setRoute('projects')}
      standalone={standalone}
    />
  );

  return (
    <div className="projects-page">
      <div className="page-head">
        <h2>Quest</h2>
      </div>
      <div className="project-empty project-ops-empty" aria-label="Quest 暂无项目">
        <span><IconFolder size={28} /></span>
        <strong>{snapshot.projects.length === 0 ? '还没有项目' : '没有可运行的项目'}</strong>
        {standalone && projects.length === 0 && (
          <StandaloneProjectBootstrap
            name={newProjectName}
            onNameChange={(value) => { setNewProjectName(value); setBootstrapError(null); }}
            onCreate={() => void createStandaloneProject()}
            creating={creatingProject}
            error={bootstrapError}
          />
        )}
        {!standalone && <button className="btn small primary" type="button" onClick={() => setRoute('projects')}>前往项目中心</button>}
      </div>
    </div>
  );
}

function StandaloneProjectBootstrap({
  name,
  onNameChange,
  onCreate,
  creating,
  error
}: {
  name: string;
  onNameChange: (value: string) => void;
  onCreate: () => void;
  creating: boolean;
  error: string | null;
}) {
  return (
    <div className="field" style={{ width: 'min(360px, 100%)', margin: 0, display: 'grid', gap: 8 }}>
      <label htmlFor="quest-new-project-name">新建 Quest 项目</label>
      <input
        id="quest-new-project-name"
        className="input"
        value={name}
        maxLength={60}
        placeholder="例如：我的新项目"
        onChange={(event) => onNameChange(event.target.value)}
        onKeyDown={(event) => { if (event.key === 'Enter') onCreate(); }}
        disabled={creating}
      />
      {error && <small role="alert">{error}</small>}
      <button className="btn small primary" type="button" disabled={creating || name.trim().length < 2} onClick={onCreate}>
        {creating ? '创建并打开…' : '创建并打开 Quest'}
      </button>
    </div>
  );
}
