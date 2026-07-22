/** 虚拟办公室：2D 卡通风格，每个数字员工一个工位，根据状态显示不同动画 */
import { useApp } from '../store';
import type { AgentCardView } from '@shared/types';

/** 根据员工状态返回办公室行为 */
function getOfficeStatus(card: AgentCardView): { emoji: string; label: string; anim: string; bubble?: string } {
  if (card.derivedStatus === 'error') return { emoji: '😵', label: '故障', anim: 'shake', bubble: '出错了…' };
  if (card.derivedStatus === 'running') return { emoji: '💻', label: '工作中', anim: 'typing', bubble: card.currentTask?.title.slice(0, 12) };
  if (card.derivedStatus === 'paused') return { emoji: '☕', label: '暂停', anim: 'idle', bubble: '休息一下' };
  if (card.derivedStatus === 'starting') return { emoji: '🚀', label: '启动中', anim: 'bounce', bubble: '准备开工' };
  // idle 状态随机摸鱼
  const idleActions = [
    { emoji: '🎮', label: '摸鱼', anim: 'idle', bubble: '摸鱼中~' },
    { emoji: '😴', label: '休息', anim: 'sleep', bubble: 'zzZ' },
    { emoji: '📱', label: '摸鱼', anim: 'idle', bubble: '刷手机' },
    { emoji: '🍜', label: '休息', anim: 'idle', bubble: '吃午饭' },
    { emoji: '🧘', label: '待命', anim: 'idle', bubble: '等待任务' },
    { emoji: '📖', label: '学习', anim: 'idle', bubble: '充电中' }
  ];
  // 用 id 的 charCode 做伪随机，保证每次渲染一致
  const idx = card.agent.id.charCodeAt(card.agent.id.length - 1) % idleActions.length;
  return idleActions[idx];
}

export function Office() {
  const { snapshot } = useApp();
  if (!snapshot) return null;
  const { agentCards } = snapshot;

  return (
    <>
      <div className="page-head">
        <h2>虚拟办公室</h2>
        <span className="desc">{agentCards.length} 位员工在岗 · 实时工作状态一览</span>
      </div>

      {/* 办公室场景 */}
      <div style={{
        background: 'linear-gradient(180deg, #1a1f2e 0%, #232a3d 100%)',
        borderRadius: 16, padding: '30px 24px', minHeight: 400,
        position: 'relative', overflow: 'hidden'
      }}>
        {/* 地板网格 */}
        <div style={{
          position: 'absolute', inset: 0, opacity: 0.06,
          backgroundImage: 'linear-gradient(90deg, #fff 1px, transparent 1px), linear-gradient(#fff 1px, transparent 1px)',
          backgroundSize: '60px 60px'
        }} />

        {/* 装饰：窗户 */}
        <div style={{ position: 'absolute', top: 12, left: 24, display: 'flex', gap: 16 }}>
          {[0, 1, 2].map((i) => (
            <div key={i} style={{ width: 70, height: 50, borderRadius: 6, background: 'linear-gradient(135deg, #2a3f5f, #1a2a44)', border: '2px solid #3a4f6f', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 20 }}>
              {i === 0 ? '🌤️' : i === 1 ? '☁️' : '🌙'}
            </div>
          ))}
        </div>

        {/* 装饰：标语 */}
        <div style={{ position: 'absolute', top: 16, right: 24, fontSize: 11, color: 'rgba(255,255,255,0.3)', fontStyle: 'italic' }}>
          "高效工作，快乐摸鱼"
        </div>

        {/* 工位网格 */}
        <div style={{
          display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(140px, 1fr))',
          gap: 18, marginTop: 70, position: 'relative', zIndex: 1
        }}>
          {agentCards.map((card) => {
            const status = getOfficeStatus(card);
            return (
              <div key={card.agent.id} className={`office-desk office-${status.anim}`} style={{
                background: 'rgba(255,255,255,0.04)', borderRadius: 12, padding: '16px 12px',
                textAlign: 'center', border: '1px solid rgba(255,255,255,0.08)',
                transition: 'transform .2s, box-shadow .2s', cursor: 'default'
              }}>
                {/* 对话气泡 */}
                {status.bubble && (
                  <div style={{
                    fontSize: 10.5, color: 'rgba(255,255,255,0.7)', background: 'rgba(255,255,255,0.1)',
                    borderRadius: 8, padding: '3px 8px', marginBottom: 8, display: 'inline-block',
                    maxWidth: '100%', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap'
                  }}>
                    {status.bubble}
                  </div>
                )}
                {/* 角色 */}
                <div style={{ fontSize: 36, marginBottom: 6, lineHeight: 1 }}>{status.emoji}</div>
                {/* 名字 */}
                <div style={{ fontSize: 12.5, fontWeight: 650, color: '#e8eaed', marginBottom: 3 }}>{card.agent.name}</div>
                {/* 状态标签 */}
                <div style={{
                  fontSize: 10.5, padding: '2px 8px', borderRadius: 4, display: 'inline-block',
                  background: status.label === '工作中' ? 'rgba(34,197,94,0.15)' : status.label === '故障' ? 'rgba(239,68,68,0.15)' : 'rgba(255,255,255,0.08)',
                  color: status.label === '工作中' ? '#4ade80' : status.label === '故障' ? '#f87171' : 'rgba(255,255,255,0.5)'
                }}>
                  {status.label}
                </div>
                {/* 工位桌子 */}
                <div style={{ marginTop: 10, height: 4, borderRadius: 2, background: 'rgba(255,255,255,0.12)' }} />
              </div>
            );
          })}
        </div>

        {/* 空办公室提示 */}
        {agentCards.length === 0 && (
          <div style={{ textAlign: 'center', color: 'rgba(255,255,255,0.3)', marginTop: 80, fontSize: 14 }}>
            办公室空空如也…去「员工市场」录用几位数字员工吧！
          </div>
        )}
      </div>

      {/* 动画样式 */}
      <style>{`
        .office-typing { animation: officeTyping 1.5s ease-in-out infinite; }
        .office-bounce { animation: officeBounce 1s ease-in-out infinite; }
        .office-shake { animation: officeShake 0.5s ease-in-out infinite; }
        .office-sleep { animation: officeSleep 3s ease-in-out infinite; }
        .office-idle { animation: officeIdle 4s ease-in-out infinite; }
        @keyframes officeTyping { 0%,100% { transform: translateY(0); } 50% { transform: translateY(-2px); } }
        @keyframes officeBounce { 0%,100% { transform: translateY(0); } 50% { transform: translateY(-6px); } }
        @keyframes officeShake { 0%,100% { transform: translateX(0); } 25% { transform: translateX(-2px); } 75% { transform: translateX(2px); } }
        @keyframes officeSleep { 0%,100% { transform: scale(1); opacity: 1; } 50% { transform: scale(0.98); opacity: 0.85; } }
        @keyframes officeIdle { 0%,100% { transform: rotate(0deg); } 25% { transform: rotate(0.5deg); } 75% { transform: rotate(-0.5deg); } }
        .office-desk:hover { transform: translateY(-3px) !important; box-shadow: 0 8px 24px rgba(0,0,0,0.3); }
      `}</style>
    </>
  );
}
