/** 应用骨架：侧边导航（分组）+ 顶栏 + 页面路由 + FAB + 全局Toast + 全局搜索 */
import { lazy, Suspense, useEffect, useState } from 'react';
import { useApp, type RouteKey } from './store';
import { Dashboard } from './pages/Dashboard';
import { CreateAgentWizard } from './wizard/CreateAgentWizard';
import { ToastContainer } from './components/Toast';
import { GlobalSearch } from './components/GlobalSearch';
import { VoicePanel } from './components/VoicePanel';
import { todayText } from './components/common';
import {
  IconAlert, IconChip, IconClock, IconCoffee, IconFlow, IconHome, IconLayers, IconMonitor, IconMoon, IconPlug, IconPlus,
  IconSettings, IconSun, IconTask, IconPlay, IconMessage, IconUser, IconFolder, IconBook, IconPhone,
  IconSearch, IconMic, IconFullscreen
} from './components/icons';

const Office = lazy(() => import('./pages/Office').then((module) => ({ default: module.Office })));
const Inbox = lazy(() => import('./pages/Inbox').then((module) => ({ default: module.Inbox })));
const Projects = lazy(() => import('./pages/Projects').then((module) => ({ default: module.Projects })));
const Deliverables = lazy(() => import('./pages/Deliverables').then((module) => ({ default: module.Deliverables })));
const Knowledge = lazy(() => import('./pages/Knowledge').then((module) => ({ default: module.Knowledge })));
const Agents = lazy(() => import('./pages/Agents').then((module) => ({ default: module.Agents })));
const Automation = lazy(() => import('./pages/Automation').then((module) => ({ default: module.Automation })));
const Tasks = lazy(() => import('./pages/Tasks').then((module) => ({ default: module.Tasks })));
const Console = lazy(() => import('./pages/Console').then((module) => ({ default: module.Console })));
const Chat = lazy(() => import('./pages/Chat').then((module) => ({ default: module.Chat })));
const Market = lazy(() => import('./pages/Market').then((module) => ({ default: module.Market })));
const Teams = lazy(() => import('./pages/Teams').then((module) => ({ default: module.Teams })));
const Collab = lazy(() => import('./pages/Collab').then((module) => ({ default: module.Collab })));
const Workflows = lazy(() => import('./pages/Workflows').then((module) => ({ default: module.Workflows })));
const Usage = lazy(() => import('./pages/Usage').then((module) => ({ default: module.Usage })));
const Engines = lazy(() => import('./pages/Engines').then((module) => ({ default: module.Engines })));
const Channels = lazy(() => import('./pages/Channels').then((module) => ({ default: module.Channels })));
const Mcp = lazy(() => import('./pages/Mcp').then((module) => ({ default: module.Mcp })));
const Skills = lazy(() => import('./pages/Skills').then((module) => ({ default: module.Skills })));
const System = lazy(() => import('./pages/System').then((module) => ({ default: module.System })));
const Settings = lazy(() => import('./pages/Settings').then((module) => ({ default: module.Settings })));
const Mobile = lazy(() => import('./pages/Mobile').then((module) => ({ default: module.Mobile })));

const NAV_GROUPS: { group: string; items: { key: RouteKey; label: string; icon: React.ReactNode }[] }[] = [
  { group: '工作', items: [
    { key: 'dashboard', label: 'AI Box 工作台', icon: <IconHome size={17} /> },
    { key: 'inbox', label: '待我处理', icon: <IconAlert size={17} /> },
    { key: 'projects', label: '项目中心', icon: <IconFolder size={17} /> },
    { key: 'office', label: '办公室', icon: <IconCoffee size={17} /> },
    { key: 'tasks', label: '任务中心', icon: <IconTask size={17} /> },
    { key: 'deliverables', label: '成果库', icon: <IconLayers size={17} /> },
    { key: 'knowledge', label: '项目知识库', icon: <IconBook size={17} /> },
    { key: 'schedules', label: '经营自动化', icon: <IconClock size={17} /> },
  ]},
  { group: '协作', items: [
    { key: 'teams', label: '专家团', icon: <IconUser size={17} /> },
    { key: 'chat', label: '对话', icon: <IconMessage size={17} /> },
    { key: 'workflows', label: '工作流', icon: <IconFlow size={17} /> },
    { key: 'collab', label: '多机协同', icon: <IconFlow size={17} /> },
  ]},
  { group: '配置', items: [
    { key: 'agents', label: '数字员工', icon: <IconUser size={17} /> },
    { key: 'market', label: '员工市场', icon: <IconUser size={17} /> },
    { key: 'engines', label: '引擎中心', icon: <IconChip size={17} /> },
    { key: 'mcp', label: 'MCP 管理', icon: <IconPlug size={17} /> },
    { key: 'skills', label: '技能管理', icon: <IconTask size={17} /> },
    { key: 'channels', label: '连接中心', icon: <IconPlug size={17} /> },
  ]},
  { group: '系统', items: [
    { key: 'console', label: '执行监控', icon: <IconPlay size={17} /> },
    { key: 'mobile', label: '手机控制台', icon: <IconPhone size={17} /> },
    { key: 'usage', label: '用量统计', icon: <IconMonitor size={17} /> },
    { key: 'system', label: '系统状态', icon: <IconMonitor size={17} /> },
    { key: 'settings', label: '设置', icon: <IconSettings size={17} /> },
  ]}
];

const ALL_NAV = NAV_GROUPS.flatMap((g) => g.items);

/** 页面按路由挂载；长任务状态由主进程持久化，避免隐藏页继续占用内存和轮询。 */
const KEEP_ALIVE: RouteKey[] = [];

export function App() {
  const { route, setRoute, theme, setTheme, wizardOpen, setWizardOpen, snapshot, deviceName, online, appVersion, actionCenter, refreshActionCenter, init } = useApp();
  const [searchOpen, setSearchOpen] = useState(false);
  const [voiceOpen, setVoiceOpen] = useState(false);

  useEffect(() => {
    void init();
    // F11 全屏切换；Ctrl/Cmd+K 全局搜索
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'F11') { e.preventDefault(); void window.aibox.toggleFullscreen(); }
      if ((e.ctrlKey || e.metaKey) && (e.key === 'k' || e.key === 'K')) { e.preventDefault(); setSearchOpen((v) => !v); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [init]);

  useEffect(() => {
    const timer = window.setInterval(() => void refreshActionCenter(), 8_000);
    return () => window.clearInterval(timer);
  }, [refreshActionCenter]);

  const todos = snapshot?.stats.pendingTodos ?? 0;
  // 行动中心聚合审批、失败、成果验收和经营风险。
  const inboxCount = actionCenter?.total ?? 0;

  /** 页面渲染器：保活页面用 display 切换，其余条件渲染 */
  const renderPage = (key: RouteKey) => {
    switch (key) {
      case 'dashboard': return <Dashboard />;
      case 'inbox': return <Inbox />;
      case 'projects': return <Projects />;
      case 'office': return <Office />;
      case 'agents': return <Agents />;
      case 'tasks': return <Tasks />;
      case 'deliverables': return <Deliverables />;
      case 'knowledge': return <Knowledge />;
      case 'schedules': return <Automation />;
      case 'workflows': return <Workflows />;
      case 'console': return <Console />;
      case 'mobile': return <Mobile />;
      case 'chat': return <Chat />;
      case 'market': return <Market />;
      case 'teams': return <Teams />;
      case 'collab': return <Collab />;
      case 'engines': return <Engines />;
      case 'mcp': return <Mcp />;
      case 'skills': return <Skills />;
      case 'channels': return <Channels />;
      case 'usage': return <Usage />;
      case 'system': return <System />;
      case 'settings': return <Settings />;
    }
  };

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="brand">
          <div className="brand-logo">AI</div>
          <div>
            <div className="brand-name">数字员工 AI Box</div>
            <div className="brand-sub">控制中心 v{appVersion}</div>
          </div>
        </div>
        <div style={{ flex: 1, overflowY: 'auto' }}>
          {NAV_GROUPS.map((g) => (
            <div key={g.group}>
              <div className="nav-group-label">{g.group}</div>
              {g.items.map((n) => (
                <button key={n.key} className={`nav-item ${route === n.key ? 'active' : ''}`} onClick={() => setRoute(n.key)}>
                  {n.icon}{n.label}
                  {n.key === 'tasks' && todos > 0 && <span className="badge">{todos}</span>}
                  {n.key === 'inbox' && inboxCount > 0 && <span className="badge">{inboxCount}</span>}
                </button>
              ))}
            </div>
          ))}
        </div>
        <div className="sidebar-footer">
          <div style={{ fontSize: 11, color: 'var(--text-3)', lineHeight: 1.7 }}>
            OPC-Nexus<br />www.apptq.com
          </div>
        </div>
      </aside>

      <div className="main-area">
        <header className="topbar">
          <span className="topbar-title">{ALL_NAV.find((n) => n.key === route)?.label}</span>
          <span className="status-pill"><span className={`dot ${online ? 'green' : 'red'}`} />{online ? '在线' : '离线'}</span>
          <span className="status-pill">{deviceName}</span>
          <div className="topbar-right">
            <button className="icon-btn" onClick={() => setSearchOpen(true)} aria-label="搜索" title="搜索 (Ctrl+K)">
              <IconSearch size={16} />
            </button>
            <button className="icon-btn" onClick={() => setVoiceOpen(true)} aria-label="语音下达任务" title="语音下达任务">
              <IconMic size={16} />
            </button>
            <span>{todayText()}</span>
            <button className="icon-btn" onClick={() => void window.aibox.toggleFullscreen()} aria-label="全屏" title="全屏 (F11)">
              <IconFullscreen size={16} />
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
          {/* 保活页面：display 切换保留状态 */}
          {KEEP_ALIVE.map((key) => (
            <div key={key} style={{ display: route === key ? 'contents' : 'none', height: '100%' }}>
              {renderPage(key)}
            </div>
          ))}
          {/* 普通页面：条件渲染 */}
          {!KEEP_ALIVE.includes(route) && (
            <Suspense fallback={<div className="page-loading">正在加载...</div>}>
              {renderPage(route)}
            </Suspense>
          )}
        </main>
      </div>

      <button className="fab" onClick={() => setWizardOpen(true)}>
        <span className="plus"><IconPlus size={16} /></span>唤起数字员工
      </button>

      {wizardOpen && <CreateAgentWizard onClose={() => setWizardOpen(false)} />}
      <GlobalSearch open={searchOpen} onClose={() => setSearchOpen(false)} />
      {voiceOpen && <VoicePanel onClose={() => setVoiceOpen(false)} />}
      <ToastContainer />
    </div>
  );
}
