/**
 * 虚拟办公室 —— 2D 卡通游戏风格（多房间版 v2）
 * 布局：顶部墙面（窗户+门）→ 中部工位区 → 下部休闲房间（含设施）→ 底部小动物通道
 * 员工空闲时到各房间活动（吃饭/睡觉/打游戏/健身），工作时回工位
 * 窗户根据电脑时间呈现白天/夜晚，夜间有暖光
 */
import { useState, useMemo, useEffect, useRef, useCallback } from 'react';
import { useApp } from '../store';
import type { AgentCardView } from '@shared/types';

/* ---------- 状态 → 办公室行为映射 ---------- */
type OfficeAction =
  | 'working' | 'gaming' | 'sleeping' | 'phone' | 'coffee'
  | 'reading' | 'meditate' | 'error' | 'starting' | 'noodles';

function getOfficeAction(card: AgentCardView): { action: OfficeAction; bubble?: string; tooltip?: string; label: string } {
  if (card.derivedStatus === 'error') return { action: 'error', bubble: '出错了…', label: '故障' };
  if (card.derivedStatus === 'starting') return { action: 'starting', bubble: '准备开工!', label: '启动中' };
  if (card.derivedStatus === 'paused') return { action: 'coffee', bubble: '休息一下~', label: '暂停' };
  if (card.derivedStatus === 'running') {
    const raw = card.currentTask?.title ?? '';
    const oneLine = raw.replace(/[#*_`>]/g, '').replace(/\s+/g, ' ').trim();
    const teamMatch = oneLine.match(/你正在参与团队「([^」]+)」/);
    const taskMatch = oneLine.match(/你的子任务（第 \d+ 步）\s*([^\n]{2,12})/);
    let short = '编码中…';
    if (teamMatch) short = `协作:${teamMatch[1]}`;
    else if (taskMatch) short = taskMatch[1];
    else if (oneLine) short = oneLine;
    if (short.length > 12) short = short.slice(0, 12) + '…';
    return { action: 'working', bubble: short, tooltip: oneLine || undefined, label: '工作中' };
  }
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

/* ---------- 日夜系统 ---------- */
function getDayNight(): { isNight: boolean; skyClass: string } {
  const hour = new Date().getHours();
  const isNight = hour < 6 || hour >= 19;
  const isDusk = (hour >= 17 && hour < 19) || (hour >= 5 && hour < 6);
  const skyClass = isNight ? 'sky-night' : isDusk ? 'sky-dusk' : 'sky-day';
  return { isNight, skyClass };
}

/* ---------- 房间定义 ---------- */
type RoomId = 'meeting' | 'rest' | 'gym' | 'fun' | 'bedroom';
const ROOMS: { id: RoomId; name: string; icon: string; furniture: string[] }[] = [
  { id: 'meeting', name: '会议室', icon: '📋', furniture: ['📊', '🪑', '📺'] },
  { id: 'rest', name: '休息室', icon: '☕', furniture: ['🛋️', '🍜', '☕'] },
  { id: 'gym', name: '健身房', icon: '🏋️', furniture: ['🏋️', '🏃', '🧘'] },
  { id: 'fun', name: '娱乐室', icon: '🎮', furniture: ['🕹️', '📺', '🎲'] },
  { id: 'bedroom', name: '卧室', icon: '🛏️', furniture: ['🛏️', '💤', '🌙'] },
];

function assignRoom(card: AgentCardView): RoomId {
  const code = card.agent.id.split('').reduce((a, c) => a + c.charCodeAt(0), 0);
  return ROOMS[code % ROOMS.length].id;
}

/* ---------- 休息时打鸡血语录 ---------- */
const HYPE_PHRASES = [
  '今天也是元气满满的一天！',
  '我可以的！冲冲冲！',
  '休息是为了更好的出发~',
  '我是最棒的数字员工！',
  '摸鱼也要摸出质量！',
  '充电完毕，随时待命！',
  '生活不止眼前的bug',
  '相信自己，你很强！',
  '今天不卷，明天更卷',
  '躺平也是一种策略',
  '我的KPI呢？算了不想了',
  '做一条有梦想的咸鱼',
];

/* ---------- 迷你角色（房间内活动） ---------- */
function MiniChar({ card, action, hype }: { card: AgentCardView; action: OfficeAction; hype?: string }) {
  const { hair, shirt } = palette(card.agent.avatarColor);
  return (
    <div className={`mini-char mini-${action}`} title={card.agent.name}>
      {hype && <div className="mini-bubble">{hype}</div>}
      <div className="mini-head" style={{ background: '#ffd9b3' }}>
        <div className="mini-hair" style={{ background: hair }} />
      </div>
      <div className="mini-body" style={{ background: shirt }} />
      <div className="mini-legs"><i /><i /></div>
    </div>
  );
}

/* ---------- 房间组件（含设施） ---------- */
function RoomPanel({ room, cards, onHover, onLeave, onClick }: {
  room: { id: RoomId; name: string; icon: string; furniture: string[] };
  cards: AgentCardView[];
  onHover: (card: AgentCardView, e: React.MouseEvent) => void;
  onLeave: () => void;
  onClick: (card: AgentCardView) => void;
}) {
  return (
    <div className={`room-panel room-${room.id}`}>
      <div className="room-header"><span className="room-icon">{room.icon}</span>{room.name}</div>
      {/* 房间设施 */}
      <div className="room-furniture">
        {room.furniture.map((f, i) => <span key={i} className="furniture-item">{f}</span>)}
      </div>
      {/* 角色 */}
      <div className="room-chars">
        {cards.map((card) => {
          const { action } = getOfficeAction(card);
          // 小概率显示打鸡血语录
          const code = card.agent.id.split('').reduce((a, c) => a + c.charCodeAt(0), 0);
          const showHype = code % 7 === new Date().getMinutes() % 7;
          const hype = showHype ? HYPE_PHRASES[code % HYPE_PHRASES.length] : undefined;
          return (
            <div key={card.agent.id} className="room-char-wrap"
              onMouseEnter={(e) => onHover(card, e)} onMouseLeave={onLeave} onClick={() => onClick(card)}>
              <MiniChar card={card} action={action} hype={hype} />
              <span className="room-char-name">{card.agent.name}</span>
            </div>
          );
        })}
        {cards.length === 0 && <div className="room-empty-hint">空无一人…</div>}
      </div>
    </div>
  );
}

/* ---------- 单个工位组件 ---------- */
function Workstation({ card, present, onHover, onLeave, onClick }: { card: AgentCardView; present: boolean; onHover: (card: AgentCardView, e: React.MouseEvent) => void; onLeave: () => void; onClick: (card: AgentCardView) => void }) {
  const { action, bubble, tooltip, label } = getOfficeAction(card);
  const { hair, shirt } = palette(card.agent.avatarColor);
  const isWorking = action === 'working';
  const isError = action === 'error';

  return (
    <div className={`ws ${isError ? 'ws-error' : ''} ${!present ? 'ws-away' : 'ws-arrive'}`} style={{ cursor: 'pointer' }}
      onMouseEnter={(e) => onHover(card, e)} onMouseLeave={onLeave} onClick={() => onClick(card)}>
      {/* 气泡：仅在人在工位时显示 */}
      {present && bubble && (
        <div className={`ws-bubble ${isWorking ? 'ws-bubble-work' : ''}`} title={tooltip}>
          {bubble}<i />
        </div>
      )}
      {!present && <div className="ws-away-tip">离开工位…</div>}
      <div className={`monitor ${isWorking && present ? 'monitor-on' : ''} ${isError ? 'monitor-err' : ''} ${(!present || action === 'sleeping') ? 'monitor-dim' : ''}`}>
        <div className="monitor-screen">
          {isWorking && present && (
            <div className="code-lines">
              <span style={{ width: '70%' }} /><span style={{ width: '45%' }} />
              <span style={{ width: '82%' }} /><span style={{ width: '38%' }} />
              <span style={{ width: '60%' }} />
            </div>
          )}
          {present && action === 'gaming' && <div className="screen-game">🎮</div>}
          {present && action === 'phone' && <div className="screen-game">📱</div>}
          {present && action === 'noodles' && <div className="screen-game">🍜</div>}
          {present && action === 'reading' && <div className="screen-game">📖</div>}
          {present && action === 'meditate' && <div className="screen-game">🧘</div>}
          {present && action === 'coffee' && <div className="screen-game">☕</div>}
          {(!present || action === 'sleeping') && <div className="screen-saver">AIBOX</div>}
          {present && action === 'starting' && <div className="screen-boot"><span className="boot-dot" /><span className="boot-dot" /><span className="boot-dot" /></div>}
          {isError && <div className="screen-err">⚠️</div>}
        </div>
        <div className="monitor-stand" />
        <div className="monitor-base" />
      </div>
      {/* 角色：仅在人在工位时渲染 */}
      {present ? (
        <div className={`char char-${action}`}>
          {action === 'sleeping' && <span className="zzz">z<span>z</span><span>Z</span></span>}
          {action === 'meditate' && <span className="zen">✧</span>}
          <div className="chair-back" />
          <div className="char-head" style={{ background: '#ffd9b3' }}>
            <div className="char-hair" style={{ background: hair }} />
            {isWorking && <div className="headset"><i /><i /></div>}
          </div>
          <div className="char-body" style={{ background: shirt }}>
            <div className={`arm arm-l ${isWorking ? 'arm-typing' : ''} ${action === 'gaming' ? 'arm-game' : ''}`} style={{ background: shirt }} />
            <div className={`arm arm-r ${isWorking ? 'arm-typing arm-delay' : ''} ${action === 'gaming' ? 'arm-game arm-delay' : ''}`} style={{ background: shirt }} />
          </div>
        </div>
      ) : (
        <div className="char char-empty"><div className="chair-back" /></div>
      )}
      <div className="desk">
        <div className="keyboard"><i /><i /><i /></div>
        <div className="mouse" />
        {present && action === 'coffee' && <div className="desk-coffee">☕</div>}
        {present && action === 'noodles' && <div className="desk-coffee">🍜</div>}
      </div>
      <div className="desk-under"><div className="chair-seat" /></div>
      <div className="ws-name">{card.agent.name}</div>
      <div className={`ws-tag ws-tag-${!present ? 'away' : isWorking ? 'work' : isError ? 'err' : 'idle'}`}>{!present ? '离开中' : label}</div>
    </div>
  );
}

/* ---------- 随机小动物（慢速闲逛后离开） ---------- */
const PET_MEMES = [
  '这个需求很简单，怎么实现我不管',
  '你加班是因为你不够热爱',
  '年轻人不要太计较工资',
  '我们是一个大家庭~',
  '996是福报喵',
  '你的潜力远不止于此',
  '别人都能做到，你为什么不行',
  '公司培养你花了多少资源',
  '要有主人翁精神汪',
  '这个bug不是我的锅',
  '明天一定上线（大概）',
  '我不是在摸鱼，是在思考架构',
  '领导说的都对',
  '再改最后一版就下班',
  '你的成长速度让我很失望',
  '格局打开，别只看眼前',
  '能者多劳嘛~',
  '我不是PUA，我是为你好',
  '下班？什么下班？',
  '要有狼性精神汪！',
];

const PET_COLORS = ['#f4a460', '#808080', '#2f2f2f', '#fff5e6', '#d2691e', '#ffd700', '#c0c0c0', '#8b4513'];

type PetKind = 'cat' | 'dog';
type PetPhase = 'wander' | 'exit-ltr' | 'exit-rtl';
interface PetState {
  id: number;
  kind: PetKind;
  color: string;
  meme: string | null;
  phase: PetPhase;
  startX: number; // 初始位置百分比
}

function RandomPets() {
  const [pets, setPets] = useState<PetState[]>([]);
  const idRef = useRef(0);

  const spawnPet = useCallback(() => {
    if (Math.random() > 0.10) return; // ~10% 概率
    setPets((prev) => {
      if (prev.length >= 2) return prev;
      const kind: PetKind = Math.random() > 0.5 ? 'cat' : 'dog';
      const color = PET_COLORS[Math.floor(Math.random() * PET_COLORS.length)];
      const meme = Math.random() > 0.5 ? PET_MEMES[Math.floor(Math.random() * PET_MEMES.length)] : null;
      const startX = 15 + Math.random() * 60; // 15%~75% 位置出现
      const id = ++idRef.current;
      // 闲逛 10~16 秒后离开
      const wanderTime = 10000 + Math.random() * 6000;
      setTimeout(() => {
        setPets((p) => p.map((pet) => pet.id === id ? { ...pet, phase: Math.random() > 0.5 ? 'exit-ltr' : 'exit-rtl' } : pet));
        // 离开动画结束后移除
        setTimeout(() => setPets((p) => p.filter((pet) => pet.id !== id)), 5000);
      }, wanderTime);
      return [...prev, { id, kind, color, meme, phase: 'wander' as PetPhase, startX }];
    });
  }, []);

  useEffect(() => {
    const timer = setInterval(spawnPet, 5000);
    return () => clearInterval(timer);
  }, [spawnPet]);

  return (
    <div className="pets-lane">
      {pets.map((pet) => (
        <div key={pet.id} className={`pet-walker pet-${pet.phase}`} style={{ left: `${pet.startX}%` }}>
          {pet.meme && pet.phase === 'wander' && <div className="pet-bubble">{pet.meme}</div>}
          {pet.kind === 'cat' ? <CssCat color={pet.color} /> : <CssDog color={pet.color} />}
        </div>
      ))}
    </div>
  );
}

function CssCat({ color }: { color: string }) {
  return (
    <div className="css-pet css-cat">
      <div className="pet-ear pet-ear-l" style={{ borderBottomColor: color }} />
      <div className="pet-ear pet-ear-r" style={{ borderBottomColor: color }} />
      <div className="pet-head-p" style={{ background: color }}>
        <div className="pet-eye" /><div className="pet-eye" />
        <div className="pet-nose" />
      </div>
      <div className="pet-body-p" style={{ background: color }} />
      <div className="pet-tail" style={{ background: color }} />
      <div className="pet-paws"><i /><i /><i /><i /></div>
    </div>
  );
}

function CssDog({ color }: { color: string }) {
  return (
    <div className="css-pet css-dog">
      <div className="pet-ear-dog pet-ear-dog-l" style={{ background: color }} />
      <div className="pet-ear-dog pet-ear-dog-r" style={{ background: color }} />
      <div className="pet-head-p pet-head-dog" style={{ background: color }}>
        <div className="pet-eye" /><div className="pet-eye" />
        <div className="pet-snout" />
      </div>
      <div className="pet-body-p" style={{ background: color }} />
      <div className="pet-tail pet-tail-dog" style={{ background: color }} />
      <div className="pet-paws"><i /><i /><i /><i /></div>
    </div>
  );
}

/* ---------- 办公室主页面 ---------- */
export function Office() {
  const { snapshot } = useApp();
  const [hoverCard, setHoverCard] = useState<{ card: AgentCardView; x: number; y: number } | null>(null);
  const [clickCard, setClickCard] = useState<AgentCardView | null>(null);
  const [teams, setTeams] = useState<{ id: string; name: string; memberIds: string[] }[]>([]);

  useMemo(() => {
    void window.aibox.listTeams().then((ts) => setTeams(ts.map((t) => ({ id: t.id, name: t.name, memberIds: t.memberIds }))));
  }, []);

  if (!snapshot) return null;
  const { agentCards } = snapshot;
  const { isNight, skyClass } = getDayNight();

  const teamMemberIds = new Set(teams.flatMap((t) => t.memberIds));
  const workingCards = agentCards.filter((c) => c.derivedStatus === 'running' || c.derivedStatus === 'error' || c.derivedStatus === 'starting');
  const idleCards = agentCards.filter((c) => c.derivedStatus !== 'running' && c.derivedStatus !== 'error' && c.derivedStatus !== 'starting');
  const soloWorkingCards = workingCards.filter((c) => !teamMemberIds.has(c.agent.id));

  // 空闲员工：约40%概率留在工位摸鱼，其余去休闲房间
  const deskSlackers: AgentCardView[] = [];
  const roomCards: Record<RoomId, AgentCardView[]> = { meeting: [], rest: [], gym: [], fun: [], bedroom: [] };
  idleCards.forEach((c) => {
    const code = c.agent.id.split('').reduce((a, ch) => a + ch.charCodeAt(0), 0);
    if (code % 5 < 2) { deskSlackers.push(c); } // ~40% 留工位摸鱼
    else { roomCards[assignRoom(c)].push(c); }
  });

  // 工位区显示所有非团队成员（工作中 + 摸鱼 + 离开的都显示工位）
  const allDeskCards = agentCards.filter((c) => !teamMemberIds.has(c.agent.id));
  const presentIds = new Set([...soloWorkingCards.map((c) => c.agent.id), ...deskSlackers.map((c) => c.agent.id)]);

  const workingCount = workingCards.length;

  return (
    <>
      <div className="page-head">
        <h2>虚拟办公室</h2>
        <span className="desc">{agentCards.length} 位员工在岗 · {workingCount} 位忙碌中 · {isNight ? '🌙 夜间' : '☀️ 白天'}</span>
      </div>

      <div className={`office-room ${isNight ? 'office-night' : ''}`}>
        {/* ===== 墙面：门在左侧，窗户居中排列 ===== */}
        <div className="office-wall">
          <div className="wall-door"><div className="door-window" /><div className="door-handle" /><div className="door-sign">AI BOX</div></div>
          <div className="wall-windows">
            <div className={`wall-window ${skyClass}`}><div className="window-sky"><span className="cloud c1" /><span className="cloud c2" />{!isNight && <span className="sun" />}{isNight && <><span className="moon" /><span className="star s1" /><span className="star s2" /><span className="star s3" /></>}</div><div className="window-frame" /></div>
            <div className={`wall-window ${skyClass}`}><div className="window-sky"><span className="cloud c1" />{!isNight && <span className="sun" />}{isNight && <><span className="moon" /><span className="star s1" /><span className="star s2" /></>}</div><div className="window-frame" /></div>
            <div className={`wall-window ${skyClass}`}><div className="window-sky"><span className="cloud c2" />{!isNight && <span className="sun" />}{isNight && <><span className="moon" /><span className="star s2" /><span className="star s3" /></>}</div><div className="window-frame" /></div>
            <div className={`wall-window ${skyClass}`}><div className="window-sky"><span className="cloud c1" /><span className="cloud c2" />{!isNight && <span className="sun" />}{isNight && <><span className="moon" /><span className="star s1" /><span className="star s3" /></>}</div><div className="window-frame" /></div>
          </div>
          <div className="wall-decor">
            <div className="wall-clock"><i /></div>
            <div className="wall-poster">🚀<span>AI POWER</span></div>
          </div>
        </div>

        {/* 地板 */}
        <div className="office-floor" />
        {isNight && <div className="night-glow" />}

        {/* ===== 内容区 ===== */}
        <div className="office-content">
          {/* 工位区：始终显示所有工位 */}
          <div className="office-main">
            <div className="section-label">💻 工位区</div>
            <div className="office-grid">
              {allDeskCards.map((card) => (
                <Workstation key={card.agent.id} card={card} present={presentIds.has(card.agent.id)}
                  onHover={(c, e) => setHoverCard({ card: c, x: e.clientX, y: e.clientY })}
                  onLeave={() => setHoverCard(null)}
                  onClick={(c) => setClickCard(c)} />
              ))}
            </div>
            {allDeskCards.length === 0 && <div className="area-empty">暂无工位…</div>}
          </div>

          {/* 休闲房间 */}
          <div className="office-rooms">
            <div className="section-label">🏠 休闲区</div>
            <div className="rooms-grid">
              {ROOMS.map((room) => (
                <RoomPanel key={room.id} room={room} cards={roomCards[room.id]}
                  onHover={(c, e) => setHoverCard({ card: c, x: e.clientX, y: e.clientY })}
                  onLeave={() => setHoverCard(null)}
                  onClick={(c) => setClickCard(c)} />
              ))}
            </div>
          </div>
        </div>

        {/* 专家团隔间 */}
        {teams.length > 0 && (
          <div className="team-compartment">
            <div className="section-label">👥 专家团工作室</div>
            <div className="team-rooms">
              {teams.map((team) => {
                const members = agentCards.filter((c) => team.memberIds.includes(c.agent.id));
                const activeMembers = members.filter((c) => c.derivedStatus === 'running');
                return (
                  <div key={team.id} className="team-room">
                    <div className="team-room-name">{team.name}</div>
                    <div className="team-room-chars">
                      {members.map((card) => {
                        const { action } = getOfficeAction(card);
                        return (
                          <div key={card.agent.id} className="room-char-wrap"
                            onMouseEnter={(e) => setHoverCard({ card, x: e.clientX, y: e.clientY })}
                            onMouseLeave={() => setHoverCard(null)}
                            onClick={() => setClickCard(card)}>
                            <MiniChar card={card} action={action} />
                            <span className="room-char-name">{card.agent.name}</span>
                          </div>
                        );
                      })}
                    </div>
                    {activeMembers.length > 0 && <div className="team-active-badge">协作中</div>}
                  </div>
                );
              })}
            </div>
          </div>
        )}

        {/* 小动物通道 */}
        <RandomPets />

        {/* 装饰 */}
        <div className="deco-plant p1"><i /><i /><i /><b /></div>
        <div className="deco-plant p2"><i /><i /><b /></div>

        {agentCards.length === 0 && (
          <div className="office-empty">
            <div className="empty-icon">🏢</div>
            办公室空空如也…去「员工市场」录用几位数字员工吧！
          </div>
        )}
      </div>

      {hoverCard && <AgentHoverCard card={hoverCard.card} x={hoverCard.x} y={hoverCard.y} />}
      {clickCard && <AgentOfficeModal card={clickCard} onClose={() => setClickCard(null)} />}
      <style>{officeCss}</style>
    </>
  );
}

/* ---------- 悬浮卡片 ---------- */
function AgentHoverCard({ card, x, y }: { card: AgentCardView; x: number; y: number }) {
  const statusLabel = card.derivedStatus === 'running' ? '执行中' : card.derivedStatus === 'error' ? '故障' : card.derivedStatus === 'paused' ? '暂停' : '空闲';
  const statusColor = card.derivedStatus === 'running' ? 'var(--accent)' : card.derivedStatus === 'error' ? 'var(--danger)' : 'var(--success)';
  return (
    <div style={{ position: 'fixed', left: Math.min(x + 12, window.innerWidth - 260), top: Math.min(y + 12, window.innerHeight - 180), zIndex: 2000, width: 240, padding: '12px 14px', borderRadius: 10, background: 'var(--card)', border: '1px solid var(--border)', boxShadow: '0 8px 24px rgba(0,0,0,.4)', pointerEvents: 'none' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
        <div style={{ width: 28, height: 28, borderRadius: 7, background: `${card.agent.avatarColor}22`, color: card.agent.avatarColor, display: 'flex', alignItems: 'center', justifyContent: 'center', fontWeight: 700, fontSize: 12 }}>{card.agent.name.slice(0, 1)}</div>
        <div style={{ flex: 1 }}>
          <div style={{ fontWeight: 650, fontSize: 13 }}>{card.agent.name}</div>
          <div style={{ fontSize: 10.5, color: 'var(--text-3)' }}>{card.agent.role.slice(0, 20)}</div>
        </div>
        <span style={{ fontSize: 10.5, color: statusColor, fontWeight: 650 }}>{statusLabel}</span>
      </div>
      <div style={{ fontSize: 11.5, color: 'var(--text-2)', lineHeight: 1.8 }}>
        <div>引擎：{card.engineName} {card.modelName ? `· ${card.modelName}` : ''}</div>
        {card.currentTask && <div>当前任务：{card.currentTask.title.slice(0, 25)}{card.currentTask.progress > 0 ? ` (${card.currentTask.progress}%)` : ''}</div>}
        {!card.currentTask && <div>当前状态：等待任务派发</div>}
      </div>
      <div style={{ fontSize: 10, color: 'var(--text-3)', marginTop: 6 }}>点击查看详细历史任务</div>
    </div>
  );
}

/* ---------- 详情弹窗 ---------- */
function AgentOfficeModal({ card, onClose }: { card: AgentCardView; onClose: () => void }) {
  const [detail, setDetail] = useState<{
    tasks: { id: string; title: string; status: string; progress: number; createdAt: number }[];
    usage: { totalTokens: number; inputTokens: number; outputTokens: number; calls: number };
  } | null>(null);

  if (!detail) {
    void window.aibox.getAgentDetail(card.agent.id).then(setDetail);
    return null;
  }

  const statusLabel = (s: string) => ({ QUEUED: '排队', RUNNING: '执行中', COMPLETED: '完成', FAILED: '失败', CANCELLED: '取消', PAUSED: '暂停' }[s] ?? s);
  const statusColor = (s: string) => s === 'COMPLETED' ? 'var(--success)' : s === 'FAILED' ? 'var(--danger)' : s === 'RUNNING' ? 'var(--accent)' : 'var(--text-3)';

  return (
    <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,.5)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 3000 }} onClick={onClose}>
      <div style={{ width: 500, maxHeight: '70vh', overflowY: 'auto', background: 'var(--card)', borderRadius: 14, padding: 20, border: '1px solid var(--border)' }} onClick={(e) => e.stopPropagation()}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 16 }}>
          <div style={{ width: 44, height: 44, borderRadius: 12, background: `${card.agent.avatarColor}22`, color: card.agent.avatarColor, display: 'flex', alignItems: 'center', justifyContent: 'center', fontWeight: 700, fontSize: 18 }}>{card.agent.name.slice(0, 1)}</div>
          <div style={{ flex: 1 }}>
            <div style={{ fontWeight: 700, fontSize: 16 }}>{card.agent.name}</div>
            <div style={{ fontSize: 12, color: 'var(--text-3)' }}>{card.agent.role} · {card.engineName}</div>
          </div>
          <button className="btn small" onClick={onClose}>×</button>
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 8, marginBottom: 16 }}>
          <div style={{ textAlign: 'center', padding: '8px', borderRadius: 8, background: 'var(--input-bg)' }}>
            <div style={{ fontSize: 16, fontWeight: 700, color: 'var(--accent)' }}>{detail.usage.totalTokens.toLocaleString()}</div>
            <div style={{ fontSize: 10.5, color: 'var(--text-3)' }}>总 Token</div>
          </div>
          <div style={{ textAlign: 'center', padding: '8px', borderRadius: 8, background: 'var(--input-bg)' }}>
            <div style={{ fontSize: 16, fontWeight: 700, color: 'var(--success)' }}>{detail.usage.calls}</div>
            <div style={{ fontSize: 10.5, color: 'var(--text-3)' }}>调用次数</div>
          </div>
          <div style={{ textAlign: 'center', padding: '8px', borderRadius: 8, background: 'var(--input-bg)' }}>
            <div style={{ fontSize: 16, fontWeight: 700, color: 'var(--warning)' }}>{detail.usage.outputTokens.toLocaleString()}</div>
            <div style={{ fontSize: 10.5, color: 'var(--text-3)' }}>输出 Token</div>
          </div>
        </div>
        <div style={{ fontWeight: 650, fontSize: 13, marginBottom: 8 }}>最近任务</div>
        {detail.tasks.length === 0 && <div style={{ fontSize: 12, color: 'var(--text-3)', marginBottom: 12 }}>暂无任务记录</div>}
        {detail.tasks.map((t) => (
          <div key={t.id} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '7px 10px', borderRadius: 6, background: 'var(--input-bg)', marginBottom: 4, fontSize: 12 }}>
            <span style={{ width: 7, height: 7, borderRadius: '50%', background: statusColor(t.status), flexShrink: 0 }} />
            <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{t.title.slice(0, 35)}</span>
            <span style={{ color: statusColor(t.status), fontWeight: 600, fontSize: 11 }}>{statusLabel(t.status)}</span>
            <span style={{ color: 'var(--text-3)', fontSize: 10.5 }}>{new Date(t.createdAt).toLocaleDateString('zh-CN', { month: '2-digit', day: '2-digit' })}</span>
          </div>
        ))}
        <div style={{ display: 'flex', gap: 8, marginTop: 14 }}>
          <button className="btn small primary" onClick={() => { void window.aibox.createTask(card.agent.id, '手动派发任务'); onClose(); }}>派发任务</button>
          <button className="btn small" onClick={() => { void window.aibox.openAgentWorkspace(card.agent.id); }}>打开工作目录</button>
          <button className="btn small" onClick={onClose}>关闭</button>
        </div>
      </div>
    </div>
  );
}

/* ---------- 样式 ---------- */
const officeCss = `
/* ===== 办公室场景 ===== */
.office-room {
  position: relative; border-radius: 16px; overflow: hidden; min-height: 520px;
  background: linear-gradient(180deg, #2b3350 0%, #2b3350 140px, #3d3226 142px, #4a3b2c 100%);
  border: 1px solid rgba(255,255,255,0.06);
}
.office-night { background: linear-gradient(180deg, #1a1f35 0%, #1a1f35 140px, #2a2318 142px, #332a1e 100%); }

/* ===== 墙面 ===== */
.office-wall {
  position: relative; height: 140px; display: flex; align-items: flex-start;
  padding: 16px 20px; gap: 16px;
}
.wall-door {
  width: 52px; height: 100px; border-radius: 6px 6px 0 0; position: relative; flex-shrink: 0;
  background: linear-gradient(180deg, #6b5b4b, #5a4a3a); border: 3px solid #7d6b58; border-bottom: none;
  align-self: flex-end;
}
.door-window { position: absolute; top: 10px; left: 50%; transform: translateX(-50%); width: 24px; height: 20px; border-radius: 4px; background: rgba(135,206,235,0.3); border: 2px solid #8a7a68; }
.door-handle { position: absolute; right: 8px; top: 55%; width: 6px; height: 6px; border-radius: 50%; background: #c9a84c; }
.door-sign { position: absolute; bottom: 8px; left: 50%; transform: translateX(-50%); font-size: 6.5px; color: #4ade80; font-weight: 700; letter-spacing: 0.5px; background: rgba(0,0,0,0.5); padding: 1px 4px; border-radius: 2px; white-space: nowrap; }
.wall-windows { display: flex; gap: 14px; flex: 1; justify-content: center; padding-top: 4px; }
.wall-decor { display: flex; flex-direction: column; align-items: center; gap: 8px; flex-shrink: 0; padding-top: 4px; }

/* 窗户 */
.wall-window {
  width: 90px; height: 62px; border-radius: 8px; position: relative; overflow: hidden;
  border: 3px solid #55617f; box-shadow: inset 0 0 16px rgba(0,0,0,0.3), 0 2px 6px rgba(0,0,0,0.3);
  flex-shrink: 0;
}
.window-sky { position: absolute; inset: 0; transition: background 2s; }
.sky-day .window-sky { background: linear-gradient(180deg, #4a90d9 0%, #87ceeb 100%); }
.sky-dusk .window-sky { background: linear-gradient(180deg, #f7b733 0%, #fcd271 60%, #87ceeb 100%); }
.sky-night .window-sky { background: linear-gradient(180deg, #0f1b3d 0%, #1a2a5e 100%); }
.cloud { position: absolute; width: 30px; height: 11px; background: rgba(255,255,255,0.9); border-radius: 7px; animation: cloudDrift 14s linear infinite; }
.sky-night .cloud { opacity: 0.12; }
.cloud::before { content: ''; position: absolute; width: 13px; height: 13px; background: inherit; border-radius: 50%; top: -6px; left: 7px; }
.c1 { top: 14px; left: -34px; }
.c2 { top: 32px; left: -34px; animation-delay: -7s; transform: scale(0.7); }
@keyframes cloudDrift { from { transform: translateX(0); } to { transform: translateX(160px); } }
.sun { position: absolute; width: 16px; height: 16px; border-radius: 50%; background: #ffe066; top: 6px; right: 10px; box-shadow: 0 0 10px #ffe066; animation: sunPulse 4s ease-in-out infinite; }
@keyframes sunPulse { 0%,100% { box-shadow: 0 0 10px #ffe066; } 50% { box-shadow: 0 0 18px #ffe066; } }
.moon { position: absolute; width: 14px; height: 14px; border-radius: 50%; background: #e8e4dc; top: 6px; right: 10px; box-shadow: 0 0 8px rgba(232,228,220,0.5); }
.moon::after { content: ''; position: absolute; top: -2px; right: -2px; width: 11px; height: 11px; border-radius: 50%; background: #1a2a5e; }
.star { position: absolute; width: 2.5px; height: 2.5px; background: #fff; border-radius: 50%; animation: starTwinkle 2s ease-in-out infinite; }
.s1 { top: 10px; left: 12px; }
.s2 { top: 24px; left: 34px; animation-delay: 0.7s; }
.s3 { top: 14px; left: 52px; animation-delay: 1.3s; }
@keyframes starTwinkle { 0%,100% { opacity: 0.3; transform: scale(0.8); } 50% { opacity: 1; transform: scale(1.2); } }
.window-frame { position: absolute; inset: 0; border-radius: 5px; box-shadow: inset 0 0 0 2px rgba(85,97,127,0.4); }
.window-frame::before { content: ''; position: absolute; left: 50%; top: 0; bottom: 0; width: 2.5px; background: #55617f; margin-left: -1.25px; }
/* 挂钟 & 海报 */
.wall-clock { width: 28px; height: 28px; border-radius: 50%; background: #e8e4dc; border: 2.5px solid #55617f; position: relative; }
.wall-clock i { position: absolute; left: 50%; top: 50%; width: 2px; height: 9px; background: #333; transform-origin: bottom center; margin-left: -1px; margin-top: -9px; border-radius: 1px; animation: clockTick 8s linear infinite; }
@keyframes clockTick { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }
.wall-poster { width: 42px; height: 54px; border-radius: 5px; background: linear-gradient(160deg, #3d4f7a, #2a3a5c); border: 2px solid #55617f; display: flex; flex-direction: column; align-items: center; justify-content: center; font-size: 16px; gap: 3px; }
.wall-poster span { font-size: 6px; letter-spacing: 0.5px; color: rgba(255,255,255,0.6); font-weight: 700; }

/* 地板 & 夜间光 */
.office-floor { position: absolute; left: 0; right: 0; top: 140px; bottom: 0; opacity: 0.4; background-image: repeating-linear-gradient(90deg, rgba(255,255,255,0.03) 0px, rgba(255,255,255,0.03) 1px, transparent 1px, transparent 80px), repeating-linear-gradient(0deg, rgba(0,0,0,0.1) 0px, rgba(0,0,0,0.1) 1px, transparent 1px, transparent 80px); }
.night-glow { position: absolute; inset: 0; z-index: 1; pointer-events: none; background: radial-gradient(ellipse at 50% 20%, rgba(255,200,100,0.07) 0%, transparent 60%); }

/* ===== 内容布局 ===== */
.office-content { position: relative; z-index: 2; display: flex; gap: 14px; padding: 12px 16px 10px; align-items: flex-start; }
.office-main { flex: 1.2; min-width: 0; }
.office-rooms { flex: 1; min-width: 300px; }
.section-label { font-size: 11px; font-weight: 700; color: rgba(255,255,255,0.45); margin-bottom: 8px; letter-spacing: 0.5px; }
.area-empty { font-size: 12px; color: rgba(255,255,255,0.25); padding: 24px; text-align: center; }

/* 工位网格 */
.office-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(140px, 1fr)); gap: 12px 10px; }

/* ===== 房间 ===== */
.rooms-grid { display: grid; grid-template-columns: repeat(2, 1fr); gap: 10px; }
.room-panel { background: rgba(255,255,255,0.035); border: 1px solid rgba(255,255,255,0.07); border-radius: 10px; padding: 10px 12px; position: relative; overflow: hidden; min-height: 120px; }
.room-header { font-size: 11px; font-weight: 700; color: rgba(255,255,255,0.65); margin-bottom: 5px; display: flex; align-items: center; gap: 5px; }
.room-icon { font-size: 13px; }
.room-furniture { display: flex; gap: 8px; margin-bottom: 8px; padding: 4px 0; border-bottom: 1px solid rgba(255,255,255,0.05); }
.furniture-item { font-size: 16px; opacity: 0.75; }
.room-chars { display: flex; flex-wrap: wrap; gap: 10px; }
.room-char-wrap { display: flex; flex-direction: column; align-items: center; gap: 3px; cursor: pointer; transition: transform 0.2s; }
.room-char-wrap:hover { transform: scale(1.12); }
.room-char-name { font-size: 9px; color: rgba(255,255,255,0.5); max-width: 60px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; text-align: center; }
.room-empty-hint { font-size: 9.5px; color: rgba(255,255,255,0.18); font-style: italic; }

/* ===== 迷你角色 ===== */
.mini-char { display: flex; flex-direction: column; align-items: center; position: relative; animation: miniWander 4s ease-in-out infinite; }
.mini-head { width: 13px; height: 12px; border-radius: 50%; position: relative; }
.mini-hair { position: absolute; top: -2px; left: -1px; right: -1px; height: 8px; border-radius: 50% 50% 30% 30%; }
.mini-body { width: 11px; height: 13px; border-radius: 4px 4px 2px 2px; margin-top: -1px; }
.mini-legs { display: flex; gap: 2px; margin-top: 1px; }
.mini-legs i { width: 4px; height: 7px; background: #4a5568; border-radius: 2px; }
.mini-bubble {
  position: absolute; bottom: 100%; left: 50%; transform: translateX(-50%); margin-bottom: 3px;
  background: rgba(255,255,255,0.92); color: #333; font-size: 8px; font-weight: 600;
  padding: 2px 6px; border-radius: 6px; white-space: nowrap; max-width: 120px;
  overflow: hidden; text-overflow: ellipsis; box-shadow: 0 1px 4px rgba(0,0,0,0.3);
  animation: bubblePop 0.3s ease-out; z-index: 10;
}
.mini-sleeping { animation: miniSleep 3.5s ease-in-out infinite; }
.mini-gaming { animation: miniRock 1.8s ease-in-out infinite; }
.mini-noodles { animation: miniEat 2s ease-in-out infinite; }
.mini-meditate { animation: miniFloat 4s ease-in-out infinite; }
.mini-working { animation: none; }
@keyframes miniWander { 0%,100% { transform: translateX(0) rotate(0deg); } 25% { transform: translateX(4px) rotate(1deg); } 50% { transform: translateX(-2px) rotate(-1deg); } 75% { transform: translateX(3px) rotate(0.5deg); } }
@keyframes miniSleep { 0%,100% { transform: translateY(0) scale(1); } 50% { transform: translateY(2px) scale(0.97); } }
@keyframes miniRock { 0%,100% { transform: rotate(0deg); } 25% { transform: rotate(-4deg); } 75% { transform: rotate(4deg); } }
@keyframes miniEat { 0%,100% { transform: translateY(0); } 30% { transform: translateY(2px); } 50% { transform: translateY(-1px); } }
@keyframes miniFloat { 0%,100% { transform: translateY(0); } 50% { transform: translateY(-3px); } }

/* ===== 专家团 ===== */
.team-compartment { position: relative; z-index: 2; padding: 8px 18px 12px; }
.team-rooms { display: flex; gap: 10px; flex-wrap: wrap; }
.team-room { background: rgba(99,102,241,0.07); border: 1px solid rgba(99,102,241,0.2); border-radius: 10px; padding: 10px 12px; min-width: 160px; position: relative; }
.team-room-name { font-size: 10.5px; font-weight: 700; color: rgba(165,180,252,0.85); margin-bottom: 6px; }
.team-room-chars { display: flex; flex-wrap: wrap; gap: 8px; }
.team-active-badge { position: absolute; top: 6px; right: 8px; font-size: 8.5px; font-weight: 700; color: #4ade80; background: rgba(74,222,128,0.12); padding: 2px 6px; border-radius: 5px; animation: badgePulse 2s ease-in-out infinite; }
@keyframes badgePulse { 0%,100% { opacity: 0.7; } 50% { opacity: 1; } }

/* ===== 工位 ===== */
.ws { display: flex; flex-direction: column; align-items: center; position: relative; padding-top: 24px; transition: transform 0.25s; }
.ws:hover { transform: translateY(-3px) scale(1.02); }
.ws-error { animation: wsShake 0.6s ease-in-out infinite; }
@keyframes wsShake { 0%,100% { translate: 0 0; } 25% { translate: -2px 0; } 75% { translate: 2px 0; } }
.ws-bubble { position: absolute; top: 0; left: 50%; transform: translateX(-50%); z-index: 5; background: rgba(255,255,255,0.95); color: #333; font-size: 10px; font-weight: 600; padding: 3px 8px; border-radius: 9px; white-space: nowrap; max-width: 120px; overflow: hidden; text-overflow: ellipsis; box-shadow: 0 2px 6px rgba(0,0,0,0.25); animation: bubblePop 0.3s ease-out; }
.ws-bubble i { position: absolute; bottom: -4px; left: 50%; margin-left: -3px; border-left: 3px solid transparent; border-right: 3px solid transparent; border-top: 4px solid rgba(255,255,255,0.95); }
.ws-bubble-work { background: #d1fae5; color: #065f46; }
.ws-bubble-work i { border-top-color: #d1fae5; }
@keyframes bubblePop { from { transform: translateX(-50%) scale(0.6); opacity: 0; } to { transform: translateX(-50%) scale(1); opacity: 1; } }

/* 显示器 */
.monitor { position: relative; z-index: 3; display: flex; flex-direction: column; align-items: center; }
.monitor-screen { width: 68px; height: 44px; border-radius: 5px 5px 2px 2px; overflow: hidden; background: #1a1e2e; border: 2.5px solid #4a5568; border-bottom-width: 3.5px; display: flex; align-items: center; justify-content: center; position: relative; transition: box-shadow 0.5s; }
.monitor-on .monitor-screen { background: #0d1b2a; border-color: #5a6a80; box-shadow: 0 0 12px rgba(80,200,255,0.2), inset 0 0 6px rgba(80,200,255,0.05); }
.monitor-err .monitor-screen { border-color: #ef4444; box-shadow: 0 0 10px rgba(239,68,68,0.4); background: #2a0f0f; }
.monitor-dim .monitor-screen { background: #111420; }
.monitor-stand { width: 7px; height: 7px; background: #4a5568; }
.monitor-base { width: 26px; height: 3.5px; border-radius: 2px; background: #4a5568; }
.code-lines { display: flex; flex-direction: column; gap: 3.5px; width: 100%; padding: 7px 8px; }
.code-lines span { height: 2.5px; border-radius: 2px; background: #4ade80; opacity: 0.85; animation: codeType 2.2s ease-in-out infinite; }
.code-lines span:nth-child(2) { background: #60a5fa; animation-delay: 0.3s; }
.code-lines span:nth-child(3) { background: #c084fc; animation-delay: 0.6s; }
.code-lines span:nth-child(4) { background: #60a5fa; animation-delay: 0.9s; }
.code-lines span:nth-child(5) { background: #4ade80; animation-delay: 1.2s; }
@keyframes codeType { 0%,100% { opacity: 0.4; } 50% { opacity: 1; } }
.screen-game { font-size: 16px; animation: screenBob 2s ease-in-out infinite; }
@keyframes screenBob { 0%,100% { transform: translateY(0); } 50% { transform: translateY(-2px); } }
.screen-saver { font-size: 7px; letter-spacing: 2px; color: rgba(255,255,255,0.25); font-weight: 700; animation: saverBlink 3s ease-in-out infinite; }
@keyframes saverBlink { 0%,100% { opacity: 0.2; } 50% { opacity: 0.5; } }
.screen-boot { display: flex; gap: 3px; }
.boot-dot { width: 4px; height: 4px; border-radius: 50%; background: #60a5fa; animation: bootBlink 1s ease-in-out infinite; }
.boot-dot:nth-child(2) { animation-delay: 0.2s; }
.boot-dot:nth-child(3) { animation-delay: 0.4s; }
@keyframes bootBlink { 0%,100% { opacity: 0.2; transform: scale(0.8); } 50% { opacity: 1; transform: scale(1.1); } }
.screen-err { font-size: 14px; animation: errFlash 0.8s ease-in-out infinite; }
@keyframes errFlash { 0%,100% { opacity: 1; } 50% { opacity: 0.3; } }

/* 桌面 */
.desk { width: 100px; height: 13px; border-radius: 3px; position: relative; z-index: 4; margin-top: -12px; background: linear-gradient(180deg, #9b7b52, #7d6142); box-shadow: 0 2px 5px rgba(0,0,0,0.4), inset 0 1px 0 rgba(255,255,255,0.2); display: flex; align-items: center; justify-content: center; gap: 5px; }
.keyboard { display: flex; gap: 2px; }
.keyboard i { width: 12px; height: 4px; border-radius: 2px; background: rgba(255,255,255,0.3); }
.mouse { width: 5px; height: 7px; border-radius: 3px; background: rgba(255,255,255,0.3); }
.desk-coffee { position: absolute; right: 5px; top: -12px; font-size: 11px; animation: steamUp 2s ease-in-out infinite; }
@keyframes steamUp { 0%,100% { transform: translateY(0); } 50% { transform: translateY(-2px); } }
.desk-under { width: 86px; height: 12px; position: relative; z-index: 1; display: flex; justify-content: center; }
.desk-under::before, .desk-under::after { content: ''; position: absolute; top: 0; width: 5px; height: 12px; background: #5f4a32; border-radius: 0 0 2px 2px; }
.desk-under::before { left: 5px; }
.desk-under::after { right: 5px; }
.chair-seat { width: 30px; height: 7px; margin-top: 2px; border-radius: 3px; background: linear-gradient(180deg, #37415f, #2c3550); }

/* 角色 */
.char { position: relative; z-index: 3; margin-top: 2px; display: flex; flex-direction: column; align-items: center; }
.chair-back { position: absolute; top: 12px; left: 50%; transform: translateX(-50%); z-index: 0; width: 38px; height: 30px; border-radius: 7px 7px 0 0; background: linear-gradient(180deg, #3d4a6b, #313d59); box-shadow: 0 2px 4px rgba(0,0,0,0.3); }
.char-head { width: 30px; height: 28px; border-radius: 50% 50% 46% 46%; position: relative; z-index: 2; box-shadow: inset -2px -2px 0 rgba(0,0,0,0.06); }
.char-hair { position: absolute; top: -3px; left: -2px; right: -2px; height: 19px; border-radius: 50% 50% 30% 30%; }
.char-hair::after { content: ''; position: absolute; bottom: -2px; left: 50%; width: 5px; height: 5px; margin-left: -2.5px; border-radius: 50%; background: inherit; }
.headset { position: absolute; top: 5px; left: -4px; right: -4px; height: 12px; }
.headset::before { content: ''; position: absolute; top: -5px; left: 3px; right: 3px; height: 10px; border: 2.5px solid #333; border-bottom: none; border-radius: 10px 10px 0 0; }
.headset i { position: absolute; top: 2px; width: 6px; height: 9px; background: #333; border-radius: 3px; }
.headset i:first-child { left: 0; }
.headset i:last-child { right: 0; }
.char-body { width: 26px; height: 21px; border-radius: 7px 7px 3px 3px; margin-top: -3px; position: relative; z-index: 1; }
.arm { position: absolute; top: 3px; width: 8px; height: 17px; border-radius: 4px; transform-origin: top center; }
.arm-l { left: -6px; transform: rotate(18deg); }
.arm-r { right: -6px; transform: rotate(-18deg); }
.arm-typing { animation: armType 0.5s ease-in-out infinite; }
.arm-delay { animation-delay: 0.25s; }
@keyframes armType { 0%,100% { transform: rotate(18deg) translateY(0); } 50% { transform: rotate(12deg) translateY(2px); } }
.arm-game { animation: armGame 0.7s ease-in-out infinite; }
@keyframes armGame { 0%,100% { transform: rotate(10deg); } 50% { transform: rotate(20deg); } }

/* 角色状态动画 */
.char-working .char-head { animation: headNod 2.5s ease-in-out infinite; }
@keyframes headNod { 0%,100% { transform: translateY(0); } 40% { transform: translateY(1.5px); } 60% { transform: translateY(0.5px); } }
.char-sleeping .char-head { animation: headDoze 3.5s ease-in-out infinite; }
@keyframes headDoze { 0%,100% { transform: translateY(0) rotate(0deg); } 50% { transform: translateY(3px) rotate(6deg); } }
.char-sleeping .char-body { animation: breathe 3.5s ease-in-out infinite; }
@keyframes breathe { 0%,100% { transform: scaleY(1); } 50% { transform: scaleY(1.04); } }
.char-starting { animation: charBounce 0.8s ease-in-out infinite; }
@keyframes charBounce { 0%,100% { transform: translateY(0); } 50% { transform: translateY(-4px); } }
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
.zzz { position: absolute; top: -12px; right: -12px; font-size: 9px; color: #93c5fd; font-weight: 700; font-style: italic; z-index: 6; animation: zzFloat 3s ease-in-out infinite; }
.zzz span { display: inline-block; }
.zzz span:first-child { font-size: 11px; animation: zzFloat 3s ease-in-out 0.5s infinite; }
.zzz span:last-child { font-size: 13px; animation: zzFloat 3s ease-in-out 1s infinite; }
@keyframes zzFloat { 0% { opacity: 0; transform: translateY(4px); } 30% { opacity: 1; } 100% { opacity: 0; transform: translateY(-8px); } }
.zen { position: absolute; top: -14px; left: 50%; margin-left: -5px; font-size: 11px; color: #c4b5fd; animation: zenPulse 2.5s ease-in-out infinite; z-index: 6; }
@keyframes zenPulse { 0%,100% { opacity: 0.3; transform: scale(0.8) translateY(0); } 50% { opacity: 1; transform: scale(1.15) translateY(-4px); } }

/* 名牌 */
.ws-name { margin-top: 6px; font-size: 11px; font-weight: 700; color: #eef0f4; text-shadow: 0 1px 3px rgba(0,0,0,0.5); max-width: 90px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; text-align: center; }
.ws-tag { margin-top: 2px; font-size: 9px; font-weight: 600; padding: 1px 7px; border-radius: 7px; }
.ws-tag-work { background: rgba(74,222,128,0.15); color: #4ade80; }
.ws-tag-err { background: rgba(248,113,113,0.15); color: #f87171; animation: errFlash 1s ease-in-out infinite; }
.ws-tag-idle { background: rgba(255,255,255,0.08); color: rgba(255,255,255,0.5); }
.ws-tag-away { background: rgba(255,255,255,0.04); color: rgba(255,255,255,0.3); }
/* 工位离开/到达动画 */
.ws-away { opacity: 0.55; }
.ws-away .monitor-screen { background: #111420; }
.ws-away-tip { position: absolute; top: 2px; left: 50%; transform: translateX(-50%); font-size: 8px; color: rgba(255,255,255,0.3); white-space: nowrap; }
.ws-arrive { animation: wsArrive 0.8s ease-out; }
@keyframes wsArrive { from { opacity: 0.4; transform: translateX(-12px); } to { opacity: 1; transform: translateX(0); } }
.char-empty { min-height: 30px; display: flex; align-items: flex-end; justify-content: center; }

/* 空状态 */
.office-empty { position: absolute; inset: 0; display: flex; flex-direction: column; align-items: center; justify-content: center; color: rgba(255,255,255,0.4); font-size: 14px; gap: 10px; z-index: 3; }
.empty-icon { font-size: 40px; animation: screenBob 3s ease-in-out infinite; }

/* 装饰 */
.deco-plant { position: absolute; bottom: 50px; width: 30px; height: 52px; z-index: 3; }
.deco-plant.p1 { left: 14px; }
.deco-plant.p2 { right: 14px; transform: scale(0.85); }
.deco-plant b { position: absolute; bottom: 0; left: 50%; transform: translateX(-50%); width: 18px; height: 15px; background: #8b5e3c; border-radius: 3px 3px 5px 5px; }
.deco-plant i { position: absolute; bottom: 13px; width: 8px; height: 22px; border-radius: 50% 50% 0 0; background: #4caf50; transform-origin: bottom center; animation: leafSway 4s ease-in-out infinite; }
.deco-plant i:nth-child(1) { left: 3px; transform: rotate(-18deg); }
.deco-plant i:nth-child(2) { left: 11px; height: 27px; animation-delay: -1.3s; }
.deco-plant i:nth-child(3) { left: 18px; transform: rotate(18deg); animation-delay: -2.6s; }
@keyframes leafSway { 0%,100% { rotate: 0deg; } 50% { rotate: 4deg; } }

/* ===== 小动物 ===== */
.pets-lane { position: absolute; bottom: 6px; left: 0; right: 0; height: 70px; z-index: 5; pointer-events: none; overflow: visible; }
.pet-walker { position: absolute; bottom: 0; display: flex; flex-direction: column; align-items: center; transition: left 0.5s; }
.pet-wander { animation: petIdle 3s ease-in-out infinite; }
.pet-exit-ltr { animation: petExitLTR 4.5s ease-in forwards; }
.pet-exit-rtl { animation: petExitRTL 4.5s ease-in forwards; }
@keyframes petIdle { 0%,100% { transform: translateX(0); } 30% { transform: translateX(8px); } 60% { transform: translateX(-6px); } 80% { transform: translateX(4px); } }
@keyframes petExitLTR { from { transform: translateX(0); } to { transform: translateX(calc(100vw)); opacity: 0; } }
@keyframes petExitRTL { from { transform: translateX(0) scaleX(-1); } to { transform: translateX(calc(-100vw)) scaleX(-1); opacity: 0; } }
.pet-bubble { position: absolute; bottom: 100%; left: 50%; transform: translateX(-50%); margin-bottom: 3px; background: rgba(255,255,255,0.92); color: #333; font-size: 8.5px; font-weight: 600; padding: 2px 7px; border-radius: 7px; white-space: nowrap; max-width: 150px; overflow: hidden; text-overflow: ellipsis; box-shadow: 0 1px 5px rgba(0,0,0,0.3); animation: bubblePop 0.3s ease-out; }
.pet-bubble::after { content: ''; position: absolute; bottom: -3px; left: 50%; margin-left: -3px; border-left: 3px solid transparent; border-right: 3px solid transparent; border-top: 4px solid rgba(255,255,255,0.92); }
/* CSS 宠物 */
.css-pet { position: relative; width: 32px; height: 26px; animation: petBob 0.7s ease-in-out infinite; }
@keyframes petBob { 0%,100% { transform: translateY(0); } 50% { transform: translateY(-1.5px); } }
.pet-head-p { position: absolute; top: 0; left: 50%; transform: translateX(-50%); width: 16px; height: 13px; border-radius: 50%; z-index: 2; }
.pet-eye { position: absolute; top: 4px; width: 2.5px; height: 2.5px; border-radius: 50%; background: #222; }
.pet-eye:first-child { left: 3.5px; }
.pet-eye:nth-child(2) { right: 3.5px; }
.pet-nose { position: absolute; bottom: 2px; left: 50%; transform: translateX(-50%); width: 3.5px; height: 2.5px; border-radius: 50%; background: #ff9999; }
.pet-snout { position: absolute; bottom: 0; left: 50%; transform: translateX(-50%); width: 7px; height: 5px; border-radius: 50%; background: rgba(0,0,0,0.12); }
.pet-body-p { position: absolute; bottom: 3px; left: 50%; transform: translateX(-50%); width: 20px; height: 12px; border-radius: 8px 8px 5px 5px; }
.pet-paws { position: absolute; bottom: 0; left: 50%; transform: translateX(-50%); display: flex; gap: 2px; }
.pet-paws i { width: 4px; height: 5px; background: rgba(0,0,0,0.2); border-radius: 2px; animation: pawStep 0.5s ease-in-out infinite; }
.pet-paws i:nth-child(2) { animation-delay: 0.12s; }
.pet-paws i:nth-child(3) { animation-delay: 0.24s; }
.pet-paws i:nth-child(4) { animation-delay: 0.36s; }
@keyframes pawStep { 0%,100% { transform: translateY(0); } 50% { transform: translateY(-1.5px); } }
.pet-ear { position: absolute; top: -4px; width: 0; height: 0; border-left: 3.5px solid transparent; border-right: 3.5px solid transparent; border-bottom: 7px solid; z-index: 3; }
.pet-ear-l { left: 7px; transform: rotate(-8deg); }
.pet-ear-r { right: 7px; transform: rotate(8deg); }
.pet-tail { position: absolute; bottom: 7px; right: -3px; width: 3.5px; height: 13px; border-radius: 2px; transform-origin: bottom center; animation: tailWag 1.4s ease-in-out infinite; }
@keyframes tailWag { 0%,100% { transform: rotate(-12deg); } 50% { transform: rotate(12deg); } }
.pet-ear-dog { position: absolute; top: 1px; width: 6px; height: 10px; border-radius: 50%; z-index: 1; }
.pet-ear-dog-l { left: 4px; transform: rotate(12deg); }
.pet-ear-dog-r { right: 4px; transform: rotate(-12deg); }
.pet-head-dog { border-radius: 45%; }
.pet-tail-dog { height: 10px; animation: tailWagFast 0.6s ease-in-out infinite; }
@keyframes tailWagFast { 0%,100% { transform: rotate(-20deg); } 50% { transform: rotate(20deg); } }
`;
