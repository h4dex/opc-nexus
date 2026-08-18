/**
 * Small, dependency-free browser client for the Nexus mobile control surface.
 *
 * It intentionally does not reuse the Electron renderer: that renderer relies
 * on `window.aibox`, which is unavailable to a normal phone browser. Keeping
 * this client inline also makes the gateway a single same-origin surface with
 * no asset traversal or third-party script dependency.
 */
export const MOBILE_CONSOLE_HTML = `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="color-scheme" content="dark light">
<title>Nexus Mobile</title>
<style>
:root{font-family:Inter,ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;color:#e8edf5;background:#11161e;line-height:1.45;--panel:#19212c;--panel-2:#202b38;--line:#344252;--muted:#9aa8b8;--accent:#6cb7ff;--danger:#ff7f86;--ok:#64d29a}
*{box-sizing:border-box}body{margin:0;min-width:320px;background:linear-gradient(180deg,#11161e 0%,#151d27 100%)}button,input,textarea{font:inherit}button{cursor:pointer;border:1px solid var(--line);border-radius:10px;background:var(--panel-2);color:inherit;min-height:44px;padding:0 14px}button.primary{border-color:#4e9fe9;background:#2879bd;color:#fff}button.ghost{background:transparent}button:disabled{opacity:.55;cursor:not-allowed}input,textarea{width:100%;border:1px solid var(--line);border-radius:10px;background:#111820;color:inherit;padding:11px 12px;outline:none}input:focus,textarea:focus{border-color:var(--accent)}
.shell{max-width:1180px;margin:0 auto;padding:env(safe-area-inset-top) 12px env(safe-area-inset-bottom);min-height:100dvh;display:flex;flex-direction:column}.topbar{display:flex;gap:10px;align-items:center;justify-content:space-between;padding:14px 2px;position:sticky;top:0;background:rgba(17,22,30,.94);backdrop-filter:blur(12px);z-index:2}.brand{font-weight:700;letter-spacing:0}.subtle{color:var(--muted);font-size:12px}.layout{display:grid;grid-template-columns:270px minmax(0,1fr);gap:12px;flex:1;min-height:0}.panel{background:rgba(25,33,44,.88);border:1px solid var(--line);border-radius:12px;overflow:hidden}.panel-title{padding:12px 14px;border-bottom:1px solid var(--line);font-size:13px;font-weight:650;display:flex;align-items:center;justify-content:space-between}.list{padding:8px;overflow:auto}.item{display:block;width:100%;text-align:left;background:transparent;border-color:transparent;padding:10px 11px;min-height:0;margin-bottom:4px}.item.active{background:#253c52;border-color:#3f6889}.item strong{display:block;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.item small{display:block;color:var(--muted);margin-top:3px}.status{display:inline-block;width:8px;height:8px;border-radius:50%;background:var(--muted);margin-right:7px}.status.ready,.status.running{background:var(--ok)}.status.error{background:var(--danger)}.main{display:flex;flex-direction:column;min-height:0}.messages{flex:1;overflow:auto;padding:14px}.message{max-width:92%;margin:0 0 12px;padding:10px 12px;border-radius:12px;white-space:pre-wrap;overflow-wrap:anywhere}.message.user{margin-left:auto;background:#1f5f8f}.message.assistant{background:#222d39}.message.system{background:transparent;color:var(--muted);font-size:12px;padding:4px 0}.message time{display:block;color:#a9bfd0;font-size:10px;margin-top:6px}.composer{border-top:1px solid var(--line);padding:10px;display:flex;gap:8px;align-items:flex-end}.composer textarea{min-height:46px;max-height:150px;resize:vertical}.empty{padding:30px 16px;text-align:center;color:var(--muted)}.approval{padding:10px;border:1px solid #765b38;background:#382d1f;border-radius:10px;margin:8px 0;font-size:13px}.approval button{margin:8px 6px 0 0;min-height:38px}.login{max-width:390px;margin:auto;width:100%;padding:18px}.login h1{margin:0 0 6px;font-size:22px}.login form{display:grid;gap:10px;margin-top:18px}.notice{min-height:20px;color:var(--danger);font-size:12px}.toolbar{display:flex;gap:8px;align-items:center}.toolbar button{min-height:38px;padding:0 10px;font-size:12px}.taskline{padding:8px 12px;border-bottom:1px solid var(--line);font-size:12px;color:var(--muted);display:none}.taskline.visible{display:block}.mobile-only{display:none}
@media(max-width:720px){.shell{padding-left:8px;padding-right:8px}.layout{display:block}.sidebar{display:none}.sidebar.open{display:block;margin-bottom:8px}.mobile-only{display:inline-flex}.main{min-height:calc(100dvh - 74px)}.topbar{padding-left:4px;padding-right:4px}.messages{padding:12px 8px}.message{max-width:96%}.composer{padding:8px 0}.composer button{padding:0 11px}}
</style>
</head>
<body>
<div id="root"></div>
<script>
(() => {
  const root = document.getElementById('root');
  const state = { csrf: '', agents: [], conversations: [], agentId: '', conversationId: '', messages: [], approvals: [], tasks: [], sidebar: false, sending: false };
  const esc = (value) => String(value ?? '').replace(/[&<>\"']/g, (c) => ({'&':'&amp;','<':'&lt;','>':'&gt;','\"':'&quot;',"'":'&#39;'}[c]));
  const fmt = (value) => value ? new Date(value).toLocaleString() : '';
  const api = async (path, options = {}) => {
    const headers = Object.assign({'Accept':'application/json'}, options.body ? {'Content-Type':'application/json'} : {}, options.headers || {});
    if (state.csrf && options.method && options.method !== 'GET') headers['X-CSRF-Token'] = state.csrf;
    const response = await fetch(path, Object.assign({}, options, {headers, credentials:'same-origin'}));
    if (response.status === 401) { renderLogin('会话已过期，请重新登录'); throw new Error('unauthorized'); }
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || '请求失败');
    return data;
  };
  const renderLogin = (error = '') => { root.innerHTML = '<main class="shell"><section class="panel login"><h1>Nexus</h1><div class="subtle">移动控制台</div><form id="login"><input id="token" type="password" autocomplete="current-password" placeholder="访问令牌" required><div class="notice">'+esc(error)+'</div><button class="primary" type="submit">登录</button></form></section></main>'; document.getElementById('login').onsubmit = async (event) => { event.preventDefault(); const token = document.getElementById('token').value; try { const result = await api('/api/mobile/login',{method:'POST',body:JSON.stringify({token})}); state.csrf = result.csrfToken || ''; await load(); } catch (e) { renderLogin(e.message); } }; };
  const selectedAgent = () => state.agents.find((item) => item.agent?.id === state.agentId || item.id === state.agentId);
  const render = () => {
    const agent = selectedAgent();
    const conv = state.conversations.find((item) => item.id === state.conversationId);
    root.innerHTML = '<main class="shell"><header class="topbar"><div><div class="brand">Nexus <span class="subtle">移动控制台</span></div><div class="subtle">'+esc(agent?.agent?.role || agent?.role || '选择数字员工')+'</div></div><div class="toolbar"><button class="ghost mobile-only" id="toggle">☰</button><button class="ghost" id="refresh">刷新</button><button class="ghost" id="logout">退出</button></div></header><div class="layout"><aside class="panel sidebar '+(state.sidebar?'open':'')+'" id="sidebar"><div class="panel-title">数字员工 <span class="subtle">'+state.agents.length+'</span></div><div class="list">'+state.agents.map((item) => { const a=item.agent||item; return '<button class="item '+(a.id===state.agentId?'active':'')+'" data-agent="'+esc(a.id)+'"><strong><span class="status '+String(item.derivedStatus||a.lifecycle||'').toLowerCase()+'"></span>'+esc(a.name)+'</strong><small>'+esc(a.role||'')+'</small></button>'; }).join('')+'</div><div class="panel-title">会话</div><div class="list">'+(state.agentId?'<button class="item '+(!state.conversationId?'active':'')+'" id="newconv"><strong>＋ 新对话</strong></button>':'')+state.conversations.map((item) => '<button class="item '+(item.id===state.conversationId?'active':'')+'" data-conv="'+esc(item.id)+'"><strong>'+esc(item.title||'未命名对话')+'</strong><small>'+esc(item.messageCount)+' 条 · '+esc(fmt(item.lastMessageAt))+'</small></button>').join('')+'</div></aside><section class="panel main"><div class="panel-title"><span>'+esc(conv?.title || (agent?.agent?.name || agent?.name || '对话'))+'</span><span class="subtle">'+(state.sending?'执行中…':'')+'</span></div><div class="taskline '+(state.tasks.some((item)=>item.status==='RUNNING'||item.status==='QUEUED')?'visible':'')+'">后台任务运行中，关闭页面不会停止执行</div><div class="messages" id="messages">'+(state.messages.length?state.messages.map((item)=>'<div class="message '+(item.direction==='inbound'||item.role==='user'?'user':'assistant')+'">'+esc(item.content||'')+'<time>'+esc(fmt(item.createdAt||item.created_at))+'</time></div>').join(''):'<div class="empty">'+(state.agentId?'发送消息开始对话':'选择一个数字员工')+'</div>')+state.approvals.map((item)=>'<div class="approval"><strong>需要审批</strong><div>'+esc(item.request||'')+'</div><button data-approve="'+esc(item.id)+'" data-value="true">批准</button><button data-approve="'+esc(item.id)+'" data-value="false">拒绝</button></div>').join('')+'</div><form class="composer" id="composer"><textarea id="message" placeholder="输入消息…" '+(!state.agentId||state.sending?'disabled':'')+'></textarea><button class="primary" type="submit" '+(!state.agentId||state.sending?'disabled':'')+'>发送</button></form></section></div></main>';
    document.querySelectorAll('[data-agent]').forEach((button) => button.onclick = async () => { state.agentId=button.dataset.agent; state.conversationId=''; state.sidebar=false; await loadConversations(); render(); });
    document.querySelectorAll('[data-conv]').forEach((button) => button.onclick = async () => { state.conversationId=button.dataset.conv; state.sidebar=false; await loadMessages(); render(); });
    document.getElementById('newconv')?.addEventListener('click', () => { state.conversationId=''; state.messages=[]; state.sidebar=false; render(); });
    document.getElementById('toggle')?.addEventListener('click', () => { state.sidebar=!state.sidebar; render(); });
    document.getElementById('refresh')?.addEventListener('click', () => void load());
    document.getElementById('logout')?.addEventListener('click', async () => { try { await api('/api/mobile/logout',{method:'POST',body:'{}'}); } finally { state.csrf=''; renderLogin(); } });
    document.getElementById('composer')?.addEventListener('submit', async (event) => { event.preventDefault(); const field=document.getElementById('message'); const message=field.value.trim(); if(!message||state.sending)return; state.sending=true; render(); try { const result=await api('/api/mobile/messages',{method:'POST',body:JSON.stringify({agentId:state.agentId,conversationId:state.conversationId||undefined,message})}); state.conversationId=result.conversationId; await loadConversations(); await loadMessages(); } catch(e) { alert(e.message); } finally { state.sending=false; render(); } });
    document.querySelectorAll('[data-approve]').forEach((button) => button.onclick = async () => { await api('/api/mobile/approvals/'+encodeURIComponent(button.dataset.approve)+'/decide',{method:'POST',body:JSON.stringify({approve:button.dataset.value==='true'})}); await load(); });
    const box=document.getElementById('messages'); if(box) box.scrollTop=box.scrollHeight;
  };
  const loadConversations = async () => { if(!state.agentId){state.conversations=[];return;} state.conversations=await api('/api/mobile/conversations?agentId='+encodeURIComponent(state.agentId)); };
  const loadMessages = async () => { if(!state.conversationId){state.messages=[];return;} state.messages=await api('/api/mobile/conversations/'+encodeURIComponent(state.conversationId)+'/messages'); };
  const load = async () => { const data=await api('/api/mobile/bootstrap'); state.agents=data.agents||[]; state.approvals=data.approvals||[]; state.tasks=data.tasks||[]; if(!state.agentId&&state.agents[0]) state.agentId=(state.agents[0].agent||state.agents[0]).id; await loadConversations(); if(state.conversationId) await loadMessages(); render(); };
  const connectEvents = () => { const source = new EventSource('/api/mobile/events'); source.onmessage = () => { void load(); }; source.onerror = () => { source.close(); setTimeout(connectEvents,4000); }; };
  api('/api/mobile/health').then(() => api('/api/mobile/bootstrap')).then((data) => { state.agents=data.agents||[]; state.approvals=data.approvals||[]; state.tasks=data.tasks||[]; if(state.agents.length) state.agentId=(state.agents[0].agent||state.agents[0]).id; return loadConversations(); }).then(() => { render(); connectEvents(); }).catch(() => renderLogin());
})();
</script>
</body>
</html>`;
