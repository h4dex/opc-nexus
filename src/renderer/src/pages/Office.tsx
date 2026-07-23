/**
 * 虚拟办公室 —— 2D 卡通游戏风格
 * 参考 Qclaw / Marvis 办公室：拟人化角色 + 电脑工位 + 状态动画
 */
import { useApp } from '../store';
import type { AgentCardView } from '@shared/types';

/* ---------- 状态 → 办公室行为映射 ---------- */
type OfficeAction =
  | 'working' | 'gaming' | 'sleeping' | 'phone' | 'coffee'
  | 'reading' | 'meditate' | 'error' | 'starting' | 'noodles';

function getOfficeAction(card: AgentCardView): { action: OfficeAction; bubble?: string; label: string } {
  if (card.derivedStatus === 'error') return { action: 'error', bubble: '出错了…', label: '故障' };
  if (card.derivedStatus === 'starting') return { action: 'starting', bubble: '准备开工!', label: '启动中' };
  if (card.derivedStatus === 'paused') return { action: 'coffee', bubble: '休息一下~', label: '暂停' };
  if (card.derivedStatus === 'running')
    return { action: 'working', bubble: card.currentTask?.title.slice(0, 10) || '编码中…', label: '工作中' };
  const idlePool: { action: OfficeAction; bubble: string; label: string }[] = [
    { action: 'gaming', bubble: '摸鱼中~', label: '摸鱼' },
    { action: 'sleeping', bubble: 'zzZ', label: '打盹' },
    { action: 'phone', bubble: '刷手机~', label: '摸鱼' },
    { action: 'noodles', bubble: '干饭中', label: '休息' },
    { action: 'meditate', bubble: '等待任务', label: '待命' },
    { action: 'reading', bubble: '充电中', label: '学习' }
  ];
  const idx = card.agent.id.charCodeAt(card.agent.id.length - 1) % idlePool.length;
  return idlePool[idx];
}

/* 根据 avatarColor 生成发色 & 衣服色 */
function palette(hex: string) {
  return { hair: hex || '#5b6abf', shirt: shadeColor(hex || '#5b6abf', -25) };
}
function shadeColor(color: string, percent: number): string {
  const num = parseInt(color.replace('#', ''), 16);
  const amt = Math.round(2.55 * percent);
  const R = Math.min(255, Math.max(0, (num >> 16) + amt));
  const G = Math.min(255, Math.max(0, ((num >> 8) & 0x00ff) + amt));
  const B = Math.min(255, Math.max(0, (num & 0x0000ff) + amt));
  return `#${(0x1000000 + R * 0x10000 + G * 0x100 + B).toString(16).slice(1)}`;
}

/* ---------- 单个工位组件 ---------- */
function Workstation({ card }: { card: AgentCardView }) {
  const { action, bubble, label } = getOfficeAction(card);
  const { hair, shirt } = palette(card.agent.avatarColor);
  const isWorking = action === 'working';
  const isError = action === 'error';

  return (
    <div className={`ws ${isError ? 'ws-error' : ''}`}>
      {/* 对话气泡 */}
      {bubble && (
        <div className={`ws-bubble ${isWorking ? 'ws-bubble-work' : ''}`}>
          {bubble}
          <i />
        </div>
      )}

      {/* 显示器 */}
      <div className={`monitor ${isWorking ? 'monitor-on' : ''} ${isError ? 'monitor-err' : ''} ${action === 'sleeping' ? 'monitor-dim' : ''}`}>
        <div className="monitor-screen">
          {isWorking && (
            <div className="code-lines">
              <span style={{ width: '70%' }} /><span style={{ width: '45%' }} />
              <span style={{ width: '82%' }} /><span style={{ width: '38%' }} />
              <span style={{ width: '60%' }} />
            </div>
          )}
          {action === 'gaming' && <div className="screen-game">🎮</div>}
          {action === 'phone' && <div className="screen-game">📱</div>}
          {action === 'noodles' && <div className="screen-game">🍜</div>}
          {action === 'reading' && <div className="screen-game">📖</div>}
          {action === 'meditate' && <div className="screen-game">🧘</div>}
          {action === 'coffee' && <div className="screen-game">☕</div>}
          {action === 'sleeping' && <div className="screen-saver">AIBOX</div>}
          {action === 'starting' && <div className="screen-boot"><span className="boot-dot" /><span className="boot-dot" /><span className="boot-dot" /></div>}
          {isError && <div className="screen-err">⚠️</div>}
        </div>
        <div className="monitor-stand" />
        <div className="monitor-base" />
      </div>

      {/* 角色（背面视角，坐在桌后） */}
      <div className={`char char-${action}`}>
        {/* 睡觉漂浮 zzZ */}
        {action === 'sleeping' && <span className="zzz">z<span>z</span><span>Z</span></span>}
        {action === 'meditate' && <span className="zen">✧</span>}
        {/* 椅子背（角色身后） */}
        <div className="chair-back" />
        {/* 头部 */}
        <div className="char-head" style={{ background: '#ffd9b3' }}>
          <div className="char-hair" style={{ background: hair }} />
          {/* 耳机 - 工作时 */}
          {isWorking && <div className="headset"><i /><i /></div>}
        </div>
        {/* 身体 + 手臂 */}
        <div className="char-body" style={{ background: shirt }}>
          <div className={`arm arm-l ${isWorking ? 'arm-typing' : ''} ${action === 'gaming' ? 'arm-game' : ''}`} style={{ background: shirt }} />
          <div className={`arm arm-r ${isWorking ? 'arm-typing arm-delay' : ''} ${action === 'gaming' ? 'arm-game arm-delay' : ''}`} style={{ background: shirt }} />
        </div>
      </div>

      {/* 桌面（前景，遮住角色下半身） */}
      <div className="desk">
        <div className="keyboard"><i /><i /><i /></div>
        <div className="mouse" />
        {action === 'coffee' && <div className="desk-coffee">☕</div>}
        {action === 'noodles' && <div className="desk-coffee">🍜</div>}
      </div>
      {/* 桌腿 + 椅子座 */}
      <div className="desk-under">
        <div className="chair-seat" />
      </div>

      {/* 名牌 & 状态 */}
      <div className="ws-name">{card.agent.name}</div>
      <div className={`ws-tag ws-tag-${isWorking ? 'work' : isError ? 'err' : 'idle'}`}>{label}</div>
    </div>
  );
}

/* ---------- 办公室主页面 ---------- */
export function Office() {
  const { snapshot } = useApp();
  if (!snapshot) return null;
  const { agentCards } = snapshot;
  const workingCount = agentCards.filter((c) => c.derivedStatus === 'running').length;

  return (
    <>
      <div className="page-head">
        <h2>虚拟办公室</h2>
        <span className="desc">{agentCards.length} 位员工在岗 · {workingCount} 位忙碌中</span>
      </div>

      <div className="office-room">
        {/* 墙面装饰 */}
        <div className="office-wall">
          <div className="wall-window"><div className="window-sky"><span className="cloud c1" /><span className="cloud c2" /></div><div className="window-frame" /></div>
          <div className="wall-window"><div className="window-sky sky-2"><span className="cloud c1" /><span className="sun" /></div><div className="window-frame" /></div>
          <div className="wall-poster">🚀<span>AI POWER</span></div>
          <div className="wall-clock"><i /></div>
          <div className="wall-slogan">"高效工作 · 快乐摸鱼"</div>
        </div>

        {/* 地板 */}
        <div className="office-floor" />

        {/* 装饰物 */}
        <div className="deco-plant p1"><i /><i /><i /><b /></div>
        <div className="deco-plant p2"><i /><i /><b /></div>
        <div className="deco-water"><b /><i /></div>

        {/* 工位区 */}
        <div className="office-grid">
          {agentCards.map((card) => (
            <Workstation key={card.agent.id} card={card} />
          ))}
        </div>

        {/* 空办公室 */}
        {agentCards.length === 0 && (
          <div className="office-empty">
            <div className="empty-icon">🏢</div>
            办公室空空如也…去「员工市场」录用几位数字员工吧！
          </div>
        )}
      </div>

      <style>{officeCss}</style>
    </>
  );
}

/* ---------- 样式 ---------- */
const officeCss = `
/* ===== 办公室场景 ===== */
.office-room {
  position: relative; border-radius: 16px; overflow: hidden; min-height: 520px;
  background: linear-gradient(180deg, #2b3350 0%, #2b3350 38%, #3d3226 38.2%, #4a3b2c 100%);
  border: 1px solid rgba(255,255,255,0.06);
}
.office-wall {
  position: absolute; top: 0; left: 0; right: 0; height: 38%;
  display: flex; align-items: flex-start; gap: 28px; padding: 18px 28px;
}
.office-floor {
  position: absolute; left: 0; right: 0; top: 38%; bottom: 0; opacity: 0.5;
  background-image:
    repeating-linear-gradient(90deg, rgba(255,255,255,0.04) 0px, rgba(255,255,255,0.04) 2px, transparent 2px, transparent 90px),
    repeating-linear-gradient(0deg, rgba(0,0,0,0.12) 0px, rgba(0,0,0,0.12) 2px, transparent 2px, transparent 90px);
}
/* 窗户 */
.wall-window {
  width: 110px; height: 76px; border-radius: 10px; position: relative; overflow: hidden;
  border: 3px solid #55617f; box-shadow: inset 0 0 20px rgba(0,0,0,0.3), 0 2px 8px rgba(0,0,0,0.3);
  flex-shrink: 0;
}
.window-sky { position: absolute; inset: 0; background: linear-gradient(180deg, #4a90d9 0%, #87ceeb 100%); }
.sky-2 { background: linear-gradient(180deg, #f7b733 0%, #fcd271 60%, #87ceeb 100%); }
.cloud {
  position: absolute; width: 36px; height: 13px; background: rgba(255,255,255,0.9); border-radius: 8px;
  animation: cloudDrift 12s linear infinite;
}
.cloud::before { content: ''; position: absolute; width: 16px; height: 16px; background: inherit; border-radius: 50%; top: -7px; left: 8px; }
.c1 { top: 16px; left: -40px; }
.c2 { top: 38px; left: -40px; animation-delay: -6s; transform: scale(0.7); }
@keyframes cloudDrift { from { transform: translateX(0); } to { transform: translateX(190px); } }
.sun { position: absolute; width: 22px; height: 22px; border-radius: 50%; background: #ffe066; top: 8px; right: 12px; box-shadow: 0 0 12px #ffe066; animation: sunPulse 4s ease-in-out infinite; }
@keyframes sunPulse { 0%,100% { box-shadow: 0 0 12px #ffe066; } 50% { box-shadow: 0 0 22px #ffe066; } }
.window-frame { position: absolute; inset: 0; border-radius: 7px; box-shadow: inset 0 0 0 2px rgba(85,97,127,0.5); }
.window-frame::before { content: ''; position: absolute; left: 50%; top: 0; bottom: 0; width: 3px; background: #55617f; margin-left: -1.5px; }
/* 海报 */
.wall-poster {
  width: 56px; height: 72px; border-radius: 6px; background: linear-gradient(160deg, #3d4f7a, #2a3a5c);
  border: 2px solid #55617f; display: flex; flex-direction: column; align-items: center; justify-content: center;
  font-size: 22px; gap: 4px; flex-shrink: 0;
}
.wall-poster span { font-size: 7px; letter-spacing: 1px; color: rgba(255,255,255,0.6); font-weight: 700; }
/* 挂钟 */
.wall-clock {
  width: 36px; height: 36px; border-radius: 50%; background: #e8e4dc; border: 3px solid #55617f;
  position: relative; flex-shrink: 0; margin-left: auto;
}
.wall-clock i {
  position: absolute; left: 50%; top: 50%; width: 2px; height: 11px; background: #333;
  transform-origin: bottom center; margin-left: -1px; margin-top: -11px; border-radius: 1px;
  animation: clockTick 8s linear infinite;
}
@keyframes clockTick { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }
.wall-slogan {
  position: absolute; right: 28px; top: 64px; font-size: 10px; color: rgba(255,255,255,0.35);
  font-style: italic; letter-spacing: 0.5px;
}
/* 盆栽 */
.deco-plant { position: absolute; bottom: 16px; width: 34px; height: 60px; }
.deco-plant.p1 { left: 20px; }
.deco-plant.p2 { right: 60px; transform: scale(0.8); }
.deco-plant b {
  position: absolute; bottom: 0; left: 50%; transform: translateX(-50%);
  width: 22px; height: 18px; background: #8b5e3c; border-radius: 3px 3px 6px 6px;
}
.deco-plant i {
  position: absolute; bottom: 16px; width: 10px; height: 26px; border-radius: 50% 50% 0 0;
  background: #4caf50; transform-origin: bottom center; animation: leafSway 4s ease-in-out infinite;
}
.deco-plant i:nth-child(1) { left: 4px; transform: rotate(-18deg); }
.deco-plant i:nth-child(2) { left: 12px; height: 32px; animation-delay: -1.3s; }
.deco-plant i:nth-child(3) { left: 20px; transform: rotate(18deg); animation-delay: -2.6s; }
@keyframes leafSway { 0%,100% { rotate: 0deg; } 50% { rotate: 4deg; } }
/* 饮水机 */
.deco-water { position: absolute; bottom: 16px; right: 16px; width: 26px; height: 52px; }
.deco-water b { position: absolute; bottom: 0; width: 26px; height: 34px; background: #dfe6ee; border-radius: 4px; }
.deco-water i { position: absolute; bottom: 32px; left: 4px; width: 18px; height: 20px; background: rgba(100,180,255,0.5); border-radius: 4px 4px 0 0; border: 2px solid rgba(255,255,255,0.4); }

/* ===== 工位网格 ===== */
.office-grid {
  position: relative; z-index: 2; display: grid;
  grid-template-columns: repeat(auto-fill, minmax(172px, 1fr));
  gap: 26px 20px; padding: 24px 28px 34px; margin-top: clamp(90px, 16vh, 140px);
}

/* ===== 单个工位 ===== */
.ws {
  display: flex; flex-direction: column; align-items: center; position: relative;
  padding-top: 26px; transition: transform 0.25s;
}
.ws:hover { transform: translateY(-4px) scale(1.02); }
.ws-error { animation: wsShake 0.6s ease-in-out infinite; }
@keyframes wsShake { 0%,100% { translate: 0 0; } 25% { translate: -2px 0; } 75% { translate: 2px 0; } }

/* 气泡 */
.ws-bubble {
  position: absolute; top: 0; left: 50%; transform: translateX(-50%); z-index: 5;
  background: rgba(255,255,255,0.95); color: #333; font-size: 10.5px; font-weight: 600;
  padding: 3px 9px; border-radius: 10px; white-space: nowrap; max-width: 130px;
  overflow: hidden; text-overflow: ellipsis; box-shadow: 0 2px 8px rgba(0,0,0,0.25);
  animation: bubblePop 0.3s ease-out;
}
.ws-bubble i {
  position: absolute; bottom: -4px; left: 50%; margin-left: -4px;
  border-left: 4px solid transparent; border-right: 4px solid transparent;
  border-top: 5px solid rgba(255,255,255,0.95);
}
.ws-bubble-work { background: #d1fae5; color: #065f46; }
.ws-bubble-work i { border-top-color: #d1fae5; }
@keyframes bubblePop { from { transform: translateX(-50%) scale(0.6); opacity: 0; } to { transform: translateX(-50%) scale(1); opacity: 1; } }

/* ===== 显示器 ===== */
.monitor { position: relative; z-index: 3; display: flex; flex-direction: column; align-items: center; }
.monitor-screen {
  width: 74px; height: 48px; border-radius: 6px 6px 2px 2px; overflow: hidden;
  background: #1a1e2e; border: 2.5px solid #4a5568; border-bottom-width: 4px;
  display: flex; align-items: center; justify-content: center; position: relative;
  box-shadow: 0 0 0 rgba(100,200,255,0); transition: box-shadow 0.5s;
}
.monitor-on .monitor-screen {
  background: #0d1b2a; border-color: #5a6a80;
  box-shadow: 0 0 14px rgba(80,200,255,0.25), inset 0 0 8px rgba(80,200,255,0.06);
}
.monitor-err .monitor-screen { border-color: #ef4444; box-shadow: 0 0 12px rgba(239,68,68,0.4); background: #2a0f0f; }
.monitor-dim .monitor-screen { background: #111420; }
.monitor-stand { width: 8px; height: 8px; background: #4a5568; }
.monitor-base { width: 30px; height: 4px; border-radius: 2px; background: #4a5568; }
/* 屏幕内容 */
.code-lines { display: flex; flex-direction: column; gap: 4px; width: 100%; padding: 8px 9px; }
.code-lines span {
  height: 3px; border-radius: 2px; background: #4ade80; opacity: 0.85;
  animation: codeType 2.2s ease-in-out infinite;
}
.code-lines span:nth-child(2) { background: #60a5fa; animation-delay: 0.3s; }
.code-lines span:nth-child(3) { background: #c084fc; animation-delay: 0.6s; }
.code-lines span:nth-child(4) { background: #60a5fa; animation-delay: 0.9s; }
.code-lines span:nth-child(5) { background: #4ade80; animation-delay: 1.2s; }
@keyframes codeType { 0%,100% { opacity: 0.4; } 50% { opacity: 1; } }
.screen-game { font-size: 18px; animation: screenBob 2s ease-in-out infinite; }
@keyframes screenBob { 0%,100% { transform: translateY(0); } 50% { transform: translateY(-2px); } }
.screen-saver { font-size: 8px; letter-spacing: 2px; color: rgba(255,255,255,0.25); font-weight: 700; animation: saverBlink 3s ease-in-out infinite; }
@keyframes saverBlink { 0%,100% { opacity: 0.2; } 50% { opacity: 0.5; } }
.screen-boot { display: flex; gap: 4px; }
.boot-dot { width: 5px; height: 5px; border-radius: 50%; background: #60a5fa; animation: bootBlink 1s ease-in-out infinite; }
.boot-dot:nth-child(2) { animation-delay: 0.2s; }
.boot-dot:nth-child(3) { animation-delay: 0.4s; }
@keyframes bootBlink { 0%,100% { opacity: 0.2; transform: scale(0.8); } 50% { opacity: 1; transform: scale(1.1); } }
.screen-err { font-size: 16px; animation: errFlash 0.8s ease-in-out infinite; }
@keyframes errFlash { 0%,100% { opacity: 1; } 50% { opacity: 0.3; } }

/* ===== 桌面（前景） ===== */
.desk {
  width: 112px; height: 15px; border-radius: 4px; position: relative; z-index: 4; margin-top: -13px;
  background: linear-gradient(180deg, #9b7b52, #7d6142);
  box-shadow: 0 3px 6px rgba(0,0,0,0.4), inset 0 1px 0 rgba(255,255,255,0.2);
  display: flex; align-items: center; justify-content: center; gap: 6px;
}
.keyboard { display: flex; gap: 2px; align-items: center; }
.keyboard i { width: 14px; height: 5px; border-radius: 2px; background: rgba(255,255,255,0.3); }
.mouse { width: 6px; height: 8px; border-radius: 3px; background: rgba(255,255,255,0.3); }
.desk-coffee { position: absolute; right: 6px; top: -14px; font-size: 12px; animation: steamUp 2s ease-in-out infinite; }
@keyframes steamUp { 0%,100% { transform: translateY(0); } 50% { transform: translateY(-2px); } }
/* 桌下空间 + 椅子座 */
.desk-under {
  width: 96px; height: 14px; position: relative; z-index: 1;
  display: flex; justify-content: center;
}
.desk-under::before, .desk-under::after {
  content: ''; position: absolute; top: 0; width: 6px; height: 14px; background: #5f4a32; border-radius: 0 0 2px 2px;
}
.desk-under::before { left: 6px; }
.desk-under::after { right: 6px; }
.chair-seat {
  width: 34px; height: 8px; margin-top: 2px; border-radius: 4px;
  background: linear-gradient(180deg, #37415f, #2c3550);
}

/* ===== 角色（坐在桌后） ===== */
.char { position: relative; z-index: 3; margin-top: 2px; display: flex; flex-direction: column; align-items: center; }
/* 椅背（角色身后可见） */
.chair-back {
  position: absolute; top: 14px; left: 50%; transform: translateX(-50%); z-index: 0;
  width: 42px; height: 34px; border-radius: 8px 8px 0 0;
  background: linear-gradient(180deg, #3d4a6b, #313d59);
  box-shadow: 0 2px 4px rgba(0,0,0,0.3);
}
.char-head {
  width: 34px; height: 32px; border-radius: 50% 50% 46% 46%; position: relative; z-index: 2;
  box-shadow: inset -3px -2px 0 rgba(0,0,0,0.06);
}
.char-hair {
  position: absolute; top: -3px; left: -2px; right: -2px; height: 22px;
  border-radius: 50% 50% 30% 30%;
}
.char-hair::after {
  content: ''; position: absolute; bottom: -3px; left: 50%; width: 6px; height: 6px;
  margin-left: -3px; border-radius: 50%; background: inherit;
}
/* 耳机 */
.headset { position: absolute; top: 6px; left: -5px; right: -5px; height: 14px; }
.headset::before { content: ''; position: absolute; top: -6px; left: 4px; right: 4px; height: 12px; border: 3px solid #333; border-bottom: none; border-radius: 12px 12px 0 0; }
.headset i { position: absolute; top: 2px; width: 7px; height: 10px; background: #333; border-radius: 3px; }
.headset i:first-child { left: 0; }
.headset i:last-child { right: 0; }
/* 身体 */
.char-body {
  width: 30px; height: 24px; border-radius: 8px 8px 4px 4px; margin-top: -4px; position: relative; z-index: 1;
}
.arm {
  position: absolute; top: 3px; width: 9px; height: 20px; border-radius: 5px;
  transform-origin: top center;
}
.arm-l { left: -7px; transform: rotate(18deg); }
.arm-r { right: -7px; transform: rotate(-18deg); }
.arm-typing { animation: armType 0.5s ease-in-out infinite; }
.arm-delay { animation-delay: 0.25s; }
@keyframes armType { 0%,100% { transform: rotate(18deg) translateY(0); } 50% { transform: rotate(12deg) translateY(2px); } }
.arm-game { animation: armGame 0.7s ease-in-out infinite; }
@keyframes armGame { 0%,100% { transform: rotate(10deg); } 50% { transform: rotate(20deg); } }

/* ===== 角色状态动画 ===== */
.char-working .char-head { animation: headNod 2.5s ease-in-out infinite; }
@keyframes headNod { 0%,100% { transform: translateY(0); } 40% { transform: translateY(1.5px); } 60% { transform: translateY(0.5px); } }
.char-sleeping .char-head { animation: headDoze 3.5s ease-in-out infinite; }
@keyframes headDoze { 0%,100% { transform: translateY(0) rotate(0deg); } 50% { transform: translateY(3px) rotate(6deg); } }
.char-sleeping .char-body { animation: breathe 3.5s ease-in-out infinite; }
@keyframes breathe { 0%,100% { transform: scaleY(1); } 50% { transform: scaleY(1.04); } }
.char-starting { animation: charBounce 0.8s ease-in-out infinite; }
@keyframes charBounce { 0%,100% { transform: translateY(0); } 50% { transform: translateY(-5px); } }
.char-gaming .char-head { animation: headRock 1.2s ease-in-out infinite; }
@keyframes headRock { 0%,100% { transform: rotate(0deg); } 25% { transform: rotate(-4deg); } 75% { transform: rotate(4deg); } }
.char-phone .char-head { animation: headTiltPhone 4s ease-in-out infinite; }
@keyframes headTiltPhone { 0%,100% { transform: rotate(0deg); } 30%,70% { transform: rotate(-8deg) translateY(2px); } }
.char-coffee .char-head { animation: sipCoffee 4s ease-in-out infinite; }
@keyframes sipCoffee { 0%,60%,100% { transform: rotate(0deg); } 70%,85% { transform: rotate(-10deg) translateY(-1px); } }
.char-meditate { animation: floatZen 4s ease-in-out infinite; }
@keyframes floatZen { 0%,100% { transform: translateY(0); } 50% { transform: translateY(-3px); } }
.char-reading .char-head { animation: readNod 3s ease-in-out infinite; }
@keyframes readNod { 0%,100% { transform: translateY(0); } 50% { transform: translateY(1.5px); } }
.char-error .char-head { animation: headDizzy 0.8s ease-in-out infinite; }
@keyframes headDizzy { 0%,100% { transform: rotate(0deg); } 25% { transform: rotate(-6deg); } 75% { transform: rotate(6deg); } }
.char-noodles .char-head { animation: eatBob 1.6s ease-in-out infinite; }
@keyframes eatBob { 0%,100% { transform: translateY(0); } 30% { transform: translateY(2px); } 50% { transform: translateY(-1px); } }
/* zzZ 漂浮 */
.zzz {
  position: absolute; top: -14px; right: -14px; font-size: 10px; color: #93c5fd;
  font-weight: 700; font-style: italic; z-index: 6; animation: zzFloat 3s ease-in-out infinite;
}
.zzz span { display: inline-block; }
.zzz span:first-child { font-size: 12px; animation: zzFloat 3s ease-in-out 0.5s infinite; }
.zzz span:last-child { font-size: 14px; animation: zzFloat 3s ease-in-out 1s infinite; }
@keyframes zzFloat { 0% { opacity: 0; transform: translateY(4px); } 30% { opacity: 1; } 100% { opacity: 0; transform: translateY(-8px); } }
.zen {
  position: absolute; top: -16px; left: 50%; margin-left: -5px; font-size: 12px; color: #c4b5fd;
  animation: zenPulse 2.5s ease-in-out infinite; z-index: 6;
}
@keyframes zenPulse { 0%,100% { opacity: 0.3; transform: scale(0.8) translateY(0); } 50% { opacity: 1; transform: scale(1.15) translateY(-4px); } }

/* ===== 名牌 & 状态标签 ===== */
.ws-name {
  margin-top: 8px; font-size: 12px; font-weight: 700; color: #eef0f4;
  text-shadow: 0 1px 3px rgba(0,0,0,0.5); max-width: 100px;
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap; text-align: center;
}
.ws-tag {
  margin-top: 3px; font-size: 9.5px; font-weight: 600; padding: 1.5px 8px; border-radius: 8px;
}
.ws-tag-work { background: rgba(74,222,128,0.15); color: #4ade80; }
.ws-tag-err { background: rgba(248,113,113,0.15); color: #f87171; animation: errFlash 1s ease-in-out infinite; }
.ws-tag-idle { background: rgba(255,255,255,0.08); color: rgba(255,255,255,0.55); }

/* 空状态 */
.office-empty {
  position: absolute; inset: 0; display: flex; flex-direction: column; align-items: center;
  justify-content: center; color: rgba(255,255,255,0.4); font-size: 14px; gap: 10px; z-index: 3;
}
.empty-icon { font-size: 42px; animation: screenBob 3s ease-in-out infinite; }
`;
