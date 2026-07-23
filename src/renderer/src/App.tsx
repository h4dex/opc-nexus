/** 应用骨架：侧边导航 + 顶栏 + 页面路由 + FAB */
import { useEffect } from 'react';
import { useApp, type RouteKey } from './store';
import { Dashboard } from './pages/Dashboard';
import { Office } from './pages/Office';
import { Agents } from './pages/Agents';
import { Schedules } from './pages/Schedules';
import { Tasks } from './pages/Tasks';
import { Console } from './pages/Console';
import { Chat } from './pages/Chat';
import { Market } from './pages/Market';
import { Teams } from './pages/Teams';
import { Workflows } from './pages/Workflows';
import { Usage } from './pages/Usage';
import { Engines } from './pages/Engines';
import { Channels } from './pages/Channels';
import { System } from './pages/System';
import { Settings } from './pages/Settings';
import { CreateAgentWizard } from './wizard/CreateAgentWizard';
import { todayText } from './components/common';
import {
  IconChip, IconClock, IconCoffee, IconFlow, IconHome, IconMonitor, IconMoon, IconPlug, IconPlus,
  IconSettings, IconSun, IconTask, IconPlay, IconMessage, IconUser
} from './components/icons';

const NAV: { key: RouteKey; label: string; icon: React.ReactNode }[] = [
  { key: 'dashboard', label: 'AI Box 工作台', icon: <IconHome size={17} /> },
  { key: 'office', label: '办公室', icon: <IconCoffee size={17} /> },
  { key: 'agents', label: '数字员工', icon: <IconUser size={17} /> },
  { key: 'tasks', label: '任务中心', icon: <IconTask size={17} /> },
  { key: 'schedules', label: '定时任务', icon: <IconClock size={17} /> },
  { key: 'workflows', label: '工作流', icon: <IconFlow size={17} /> },
  { key: 'console', label: '执行监控', icon: <IconPlay size={17} /> },
  { key: 'chat', label: '对话', icon: <IconMessage size={17} /> },
  { key: 'market', label: '员工市场', icon: <IconUser size={17} /> },
  { key: 'teams', label: '专家团', icon: <IconUser size={17} /> },
  { key: 'engines', label: '引擎中心', icon: <IconChip size={17} /> },
  { key: 'channels', label: '连接中心', icon: <IconPlug size={17} /> },
  { key: 'usage', label: '用量统计', icon: <IconMonitor size={17} /> },
  { key: 'system', label: '系统状态', icon: <IconMonitor size={17} /> },
  { key: 'settings', label: '设置', icon: <IconSettings size={17} /> }
];

export function App() {
  const { route, setRoute, theme, setTheme, wizardOpen, setWizardOpen, snapshot, deviceName, online, init } = useApp();

  useEffect(() => {
    void init();
    // F11 全屏切换
    const onKey = (e: KeyboardEvent) => { if (e.key === 'F11') { e.preventDefault(); void window.aibox.toggleFullscreen(); } };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [init]);

  const todos = snapshot?.stats.pendingTodos ?? 0;

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="brand">
          <div className="brand-logo">AI</div>
          <div>
            <div className="brand-name">数字员工 AI Box</div>
            <div className="brand-sub">控制中心 v1.0</div>
          </div>
        </div>
        {NAV.map((n) => (
          <button key={n.key} className={`nav-item ${route === n.key ? 'active' : ''}`} onClick={() => setRoute(n.key)}>
            {n.icon}{n.label}
            {n.key === 'tasks' && todos > 0 && <span className="badge">{todos}</span>}
          </button>
        ))}
        <div className="sidebar-footer">
          <div style={{ fontSize: 11, color: 'var(--text-3)', lineHeight: 1.7 }}>
            本地优先 · 数据不出设备<br />Windows / Ubuntu
          </div>
        </div>
      </aside>

      <div className="main-area">
        <header className="topbar">
          <span className="topbar-title">{NAV.find((n) => n.key === route)?.label}</span>
          <span className="status-pill"><span className={`dot ${online ? 'green' : 'red'}`} />{online ? '在线' : '离线'}</span>
          <span className="status-pill">{deviceName}</span>
          <div className="topbar-right">
            <span>{todayText()}</span>
            <button className="icon-btn" onClick={() => void window.aibox.toggleFullscreen()} aria-label="全屏" title="全屏 (F11)">
              ⛶
            </button>
            <button className="icon-btn" onClick={() => setTheme(theme === 'dark' ? 'light' : 'dark')} aria-label="切换主题">
              {theme === 'dark' ? <IconSun size={16} /> : <IconMoon size={16} />}
            </button>
            <button className="icon-btn" onClick={() => setRoute('settings')} aria-label="设置">
              <IconSettings size={16} />
            </button>
          </div>
        </header>

        <main className="content">
          {route === 'dashboard' && <Dashboard />}
          {route === 'office' && <Office />}
          {route === 'agents' && <Agents />}
          {route === 'tasks' && <Tasks />}
          {route === 'schedules' && <Schedules />}
          {route === 'workflows' && <Workflows />}
          {route === 'console' && <Console />}
          {route === 'chat' && <Chat />}
          {route === 'market' && <Market />}
          {route === 'teams' && <Teams />}
          {route === 'engines' && <Engines />}
          {route === 'channels' && <Channels />}
          {route === 'usage' && <Usage />}
          {route === 'system' && <System />}
          {route === 'settings' && <Settings />}
        </main>
      </div>

      <button className="fab" onClick={() => setWizardOpen(true)}>
        <span className="plus"><IconPlus size={16} /></span>唤起数字员工
      </button>

      {wizardOpen && <CreateAgentWizard onClose={() => setWizardOpen(false)} />}
    </div>
  );
}
