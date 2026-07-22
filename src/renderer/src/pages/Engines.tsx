/** 引擎中心（PRD 9.x）：检测、安装、登录、默认引擎、健康状态 */
import { useState } from 'react';
import { useApp } from '../store';
import { IconAlert, IconChip, IconRefresh } from '../components/icons';
import type { Engine } from '@shared/types';

const STATUS_META: Record<Engine['status'], { label: string; tag: string }> = {
  NOT_INSTALLED: { label: '未安装', tag: 'gray' },
  INSTALLING: { label: '安装中', tag: 'blue' },
  SETUP_REQUIRED: { label: '待配置（演示模式）', tag: 'orange' },
  AUTH_REQUIRED: { label: '待登录', tag: 'orange' },
  HEALTHY: { label: '健康', tag: 'green' },
  DEGRADED: { label: '降级', tag: 'orange' },
  ERROR: { label: '异常', tag: 'red' }
};

export function Engines() {
  const { snapshot } = useApp();
  const [detecting, setDetecting] = useState(false);
  /** 引擎 id → 安装结果消息（成功/失败均如实展示） */
  const [installMsg, setInstallMsg] = useState<Record<string, { ok: boolean; message: string }>>({});
  if (!snapshot) return null;
  const { engines, executorAvailable } = snapshot;

  const redetect = async () => {
    setDetecting(true);
    try {
      await window.aibox.detectEngines();
    } finally {
      setDetecting(false);
    }
  };

  const install = async (id: string) => {
    setInstallMsg((m) => ({ ...m, [id]: { ok: true, message: '正在下载安装（下载源见设置页，可能需要数分钟）…' } }));
    const r = await window.aibox.installEngine(id);
    setInstallMsg((m) => ({ ...m, [id]: r }));
  };

  const showGuide = async (id: string) => {
    const g = await window.aibox.getInstallGuide(id);
    if (!g) return;
    setInstallMsg((m) => ({ ...m, [id]: { ok: true, message: `手工安装指引：${g.guide}` } }));
    if (g.url) void window.aibox.openExternal(g.url);
  };

  return (
    <>
      <div className="page-head">
        <h2>引擎中心</h2>
        <span className="desc">同一界面检测、安装、登录、升级、启停执行引擎（G2）</span>
        <div className="right">
          <button className="btn small" disabled={detecting} onClick={() => void redetect()}>
            <IconRefresh size={13} />{detecting ? '检测中…' : '重新检测'}
          </button>
        </div>
      </div>

      {/* 最低运行条件：至少一个可用执行器（任一 CLI 健康或 Hermes 已配置供应商） */}
      {!executorAvailable && (
        <div className="card" style={{ marginBottom: 16, display: 'flex', gap: 10, alignItems: 'center', color: 'var(--warning)', background: 'var(--warning-soft)' }}>
          <IconAlert size={18} />
          <div style={{ fontSize: 12.5, lineHeight: 1.8 }}>
            <b>未检测到可用执行引擎，系统当前以演示模式运行。</b>
            请安装下方任一 CLI 引擎（点击「自动安装」），或在设置页完成 Hermes 模型供应商配置——至少一个执行器就绪后任务才会真实执行。
          </div>
        </div>
      )}

      <div className="agent-grid" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(320px, 1fr))' }}>
        {engines.map((e) => {
          const meta = STATUS_META[e.status];
          const msg = installMsg[e.id];
          return (
            <div className="card" key={e.id}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 12 }}>
                <div className="agent-avatar" style={{ width: 44, height: 44, borderRadius: 12, background: 'var(--accent-soft)', color: 'var(--accent)' }}>
                  <IconChip size={24} />
                </div>
                <div style={{ flex: 1 }}>
                  <div style={{ fontWeight: 650, fontSize: 14.5, display: 'flex', gap: 8, alignItems: 'center' }}>
                    {e.name}
                    {e.isDefault && <span className="tag blue">默认</span>}
                  </div>
                  <div style={{ fontSize: 12, color: 'var(--text-2)', marginTop: 2 }}>
                    {e.version ? `v${e.version}` : '—'} · 运行实例 {e.runningInstances}
                  </div>
                </div>
                <span className={`tag ${meta.tag}`}>{meta.label}</span>
              </div>

              <div style={{ fontSize: 12, color: 'var(--text-2)', background: 'var(--input-bg)', borderRadius: 8, padding: '8px 12px', marginBottom: 12 }}>
                数据边界：{e.dataBoundary}
              </div>

              {/* 引擎安装路径与版本（检测后可见） */}
              {e.path && (
                <div style={{ fontSize: 12, color: 'var(--text-2)', background: 'var(--input-bg)', borderRadius: 8, padding: '8px 12px', marginBottom: 12, wordBreak: 'break-all' }}>
                  安装路径：<code style={{ fontSize: 11.5 }}>{e.path}</code>
                </div>
              )}

              {/* P1a：泛化 CLI 无统一权限参数约定，权限由 CLI 自身配置控制 */}
              {['zcode', 'opencode', 'kimicode'].includes(e.type) && (
                <div style={{ fontSize: 12, color: 'var(--warning)', background: 'var(--warning-soft)', borderRadius: 8, padding: '8px 12px', marginBottom: 12 }}>
                  权限提示：该引擎的权限由 CLI 自身配置控制（员工权限模式不自动映射）；可在配置文件 engines[{e.id}].runArgs 中自行附加沙箱/权限参数。
                </div>
              )}

              {msg && (
                <div style={{ fontSize: 12, lineHeight: 1.7, whiteSpace: 'pre-wrap', color: msg.ok ? 'var(--text-2)' : 'var(--danger)', background: 'var(--input-bg)', borderRadius: 8, padding: '8px 12px', marginBottom: 12 }}>
                  {msg.message}
                </div>
              )}

              <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                {e.status === 'NOT_INSTALLED' && e.installable && (
                  <button className="btn small primary" onClick={() => void install(e.id)}>自动安装</button>
                )}
                {e.status === 'NOT_INSTALLED' && (
                  <button className="btn small" onClick={() => void showGuide(e.id)}>安装指引</button>
                )}
                {e.status === 'INSTALLING' && (
                  <button className="btn small" disabled><IconRefresh size={13} />安装中…</button>
                )}
                {e.status === 'SETUP_REQUIRED' && (
                  <span style={{ fontSize: 12, color: 'var(--warning)', alignSelf: 'center' }}>请在设置页完成模型供应商配置</span>
                )}
                {e.status === 'AUTH_REQUIRED' && (
                  <button className="btn small primary" onClick={() => void window.aibox.authEngine(e.id)}>登录授权</button>
                )}
                {e.status === 'HEALTHY' && !e.isDefault && (
                  <button className="btn small" onClick={() => void window.aibox.setDefaultEngine(e.id)}>设为默认</button>
                )}
                {e.status === 'HEALTHY' && <span style={{ fontSize: 12, color: 'var(--success)', alignSelf: 'center' }}>✓ 可用于任务调度</span>}
              </div>
            </div>
          );
        })}
      </div>

      <div className="card" style={{ marginTop: 16 }}>
        <div className="card-title">供应链安全说明</div>
        <div style={{ fontSize: 12.5, color: 'var(--text-2)', lineHeight: 1.9 }}>
          自动安装固定使用各引擎官方 npm 包名，经 npm 完整性校验（integrity）下载；下载地址（registry）可在设置页或配置文件
          aibox.config.json 中修改（9.3）。ZCode 等无公开包的引擎仅提供官方指引，不做假安装。
          外部引擎导入仅完成注册，不自动授予工作目录、网络、密钥或管理员权限（9.5）。
        </div>
      </div>
    </>
  );
}
