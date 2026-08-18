import { useCallback, useEffect, useMemo, useState } from 'react';
import type {
  CreatePlanningSessionInput,
  PlanningComplexitySignalsInput,
  PlanningQuestionAnswerInput,
  PlanningSessionView
} from '@shared/types';
import { IconAlert, IconCheck, IconClock, IconFlow, IconPlay, IconRefresh, IconShield, IconX } from '../components/icons';
import { toast } from '../components/Toast';
import { useApp } from '../store';
import '../styles/secretaryPlanning.css';

type AnswerDraft = { selectedOptionIds: string[]; text: string };

const INITIAL_SIGNALS: PlanningComplexitySignalsInput = {
  departmentIds: ['department-a'],
  hasCrossTeamDependencies: false,
  ambiguousObjective: false,
  ambiguousScope: false,
  ambiguousAcceptance: false,
  estimatedDurationMinutes: 30,
  estimatedCost: 1,
  estimatedTokenCount: 10_000,
  requiresNewTeam: false,
  irreversibleOperations: [],
  compareAlternatives: false,
  phasedExecution: false,
  confirmBeforeExecution: true,
  estimatedTaskCount: 1
};

const REASONS: Record<string, string> = {
  CROSS_TEAM: '跨团队', AMBIGUOUS_OBJECTIVE: '目标不清', AMBIGUOUS_SCOPE: '范围不清',
  AMBIGUOUS_ACCEPTANCE: '验收不清', LONG_TASK: '长任务', HIGH_COST: '费用偏高',
  HIGH_TOKEN_BUDGET: 'token 偏高', NEW_TEAM: '新团队', IRREVERSIBLE_OPERATION: '不可逆操作',
  COMPARE_ALTERNATIVES: '需要比较', PHASED_EXECUTION: '分阶段', EXPLICIT_CONFIRMATION: '先确认',
  COMPLEXITY_SCORE: '复杂度门禁'
};

const STATUS_LABEL: Record<string, string> = {
  DRAFT: '草稿', NEEDS_INPUT: '等待回答', PROPOSED: '待批准', APPROVED: '已批准',
  DISPATCHED: '已派工', CLOSED: '已关闭', REJECTED: '已拒绝', SUPERSEDED: '已替代', CANCELLED: '已取消'
};

const DISPATCH_LABEL: Record<string, string> = {
  NOT_STARTED: '未派工', IN_PROGRESS: '派工中', PARTIAL: '部分完成', FAILED: '派工失败', DISPATCHED: '已派工'
};

function formatNumber(value: number): string {
  return new Intl.NumberFormat('zh-CN', { maximumFractionDigits: 2 }).format(value);
}

function formatTime(value: number): string {
  return new Date(value).toLocaleString('zh-CN', { hour12: false });
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function SecretaryPlanning() {
  const { secretarySessionId, clearSecretarySession } = useApp();
  const [sessions, setSessions] = useState<PlanningSessionView['id'][]>([]);
  const [sessionSummaries, setSessionSummaries] = useState<Awaited<ReturnType<typeof window.aibox.listPlanningSessions>>>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [session, setSession] = useState<PlanningSessionView | null>(null);
  const [request, setRequest] = useState('');
  const [signals, setSignals] = useState<PlanningComplexitySignalsInput>(INITIAL_SIGNALS);
  const [answers, setAnswers] = useState<Record<string, AnswerDraft>>({});
  const [busy, setBusy] = useState<string | null>(null);

  const refreshList = useCallback(async () => {
    const next = await window.aibox.listPlanningSessions(50);
    setSessionSummaries(next);
    setSessions(next.map((item) => item.id));
    setSelectedId((current) => current && next.some((item) => item.id === current) ? current : next[0]?.id ?? null);
  }, []);

  const refreshSession = useCallback(async (id: string) => {
    const next = await window.aibox.getPlanningSession(id);
    setSession(next);
    const restored: Record<string, AnswerDraft> = {};
    for (const answer of next.questionSet?.answers ?? []) restored[answer.questionId] = { selectedOptionIds: answer.selectedOptionIds, text: answer.text ?? '' };
    setAnswers(restored);
  }, []);

  useEffect(() => {
    void refreshList().catch((error) => toast.err(`读取规划失败：${errorMessage(error)}`));
  }, [refreshList]);

  useEffect(() => {
    if (!selectedId) { setSession(null); return; }
    void refreshSession(selectedId).catch((error) => toast.err(`读取规划失败：${errorMessage(error)}`));
  }, [refreshSession, selectedId]);

  useEffect(() => {
    if (!secretarySessionId) return;
    setSelectedId(secretarySessionId);
    clearSecretarySession();
  }, [clearSecretarySession, secretarySessionId]);

  const run = async (label: string, operation: () => Promise<PlanningSessionView | { view: PlanningSessionView; ok: boolean; error: { code: string; message: string } | null }>) => {
    setBusy(label);
    try {
      const result = await operation();
      const next = 'view' in result ? result.view : result;
      setSession(next);
      setSelectedId(next.id);
      await refreshList();
      if ('ok' in result && !result.ok) toast.err(result.error?.message ?? '操作未完成');
      else toast.ok(label);
    } catch (error) {
      toast.err(errorMessage(error));
      if (selectedId) void refreshSession(selectedId);
    } finally {
      setBusy(null);
    }
  };

  const create = async () => {
    if (!request.trim()) return;
    await run('规划请求已创建', async () => {
      const input: CreatePlanningSessionInput = { request: request.trim(), signals };
      const next = await window.aibox.createPlanningSession(input);
      setRequest('');
      return next;
    });
  };

  const answerQuestions = async () => {
    if (!session?.questionSet || session.activeQuestionSetVersion === null) return;
    const payload: PlanningQuestionAnswerInput[] = session.questionSet.questions.map((question) => {
      const draft = answers[question.id] ?? { selectedOptionIds: [], text: '' };
      return { questionId: question.id, selectedOptionIds: draft.selectedOptionIds, text: draft.text.trim() || null };
    });
    await run('回答已保存', () => window.aibox.answerPlanningQuestions({
      sessionId: session.id,
      expectedRevision: session.revision,
      questionSetVersion: session.activeQuestionSetVersion!,
      answers: payload
    }));
  };

  const currentPlan = useMemo(() => {
    if (!session || session.planVersions.length === 0) return null;
    return session.planVersions.find((version) => version.version === session.latestPlanVersion) ?? session.planVersions.at(-1)!;
  }, [session]);

  const setSignal = <K extends keyof PlanningComplexitySignalsInput>(key: K, value: PlanningComplexitySignalsInput[K]) => {
    setSignals((previous) => ({ ...previous, [key]: value }));
  };

  const toggleAnswerOption = (questionId: string, optionId: string, kind: 'single' | 'multi') => {
    setAnswers((previous) => {
      const current = previous[questionId] ?? { selectedOptionIds: [], text: '' };
      const selectedOptionIds = kind === 'single'
        ? current.selectedOptionIds.includes(optionId) ? [] : [optionId]
        : current.selectedOptionIds.includes(optionId)
          ? current.selectedOptionIds.filter((id) => id !== optionId)
          : [...current.selectedOptionIds, optionId];
      return { ...previous, [questionId]: { ...current, selectedOptionIds } };
    });
  };

  return (
    <div className="secretary-page">
      <div className="page-head secretary-head">
        <div>
          <h2><IconShield size={19} />兼容规划（Local CLI）</h2>
          <span className="desc">旧 CLI 迁移入口；DSH/Cordis Quest 在项目工作台处理</span>
        </div>
        <button className="btn" onClick={() => void refreshList()} title="刷新规划列表" aria-label="刷新规划列表"><IconRefresh size={14} />刷新</button>
      </div>

      <div className="secretary-layout">
        <aside className="secretary-sidebar">
          <div className="secretary-sidebar-title">规划会话 <span>{sessionSummaries.length}</span></div>
          <div className="secretary-session-list">
            {sessionSummaries.length === 0 && <div className="empty">还没有规划请求</div>}
            {sessionSummaries.map((item) => (
              <button key={item.id} className={`secretary-session-item ${item.id === selectedId ? 'active' : ''}`} onClick={() => setSelectedId(item.id)}>
                <strong>{item.request.slice(0, 54)}</strong>
                <span><span className={`tag ${item.status === 'APPROVED' || item.status === 'DISPATCHED' ? 'green' : item.status === 'REJECTED' ? 'red' : 'orange'}`}>{STATUS_LABEL[item.status] ?? item.status}</span><small>v{item.latestPlanVersion || '-'}</small></span>
              </button>
            ))}
          </div>
        </aside>

        <main className="secretary-main">
          {!session ? (
            <CreatePanel request={request} signals={signals} busy={busy} onRequest={setRequest} onSignal={setSignal} onCreate={() => void create()} />
          ) : (
            <>
              <section className="secretary-overview">
                <div className="secretary-overview-main">
                  <div className="eyebrow">SESSION {session.id}</div>
                  <h3>{session.request}</h3>
                  <div className="secretary-meta-row">
                    <span className={`tag ${session.status === 'REJECTED' ? 'red' : session.status === 'APPROVED' || session.status === 'DISPATCHED' ? 'green' : 'orange'}`}>{STATUS_LABEL[session.status]}</span>
                    <span className="tag gray">revision {session.revision}</span>
                    <span className="tag gray">更新于 {formatTime(session.updatedAt)}</span>
                  </div>
                </div>
                <div className="secretary-gate-score">
                  <span>复杂度</span><strong>{session.gateDecision.complexityScore}</strong>
                  <span>风险</span><strong>{session.gateDecision.riskScore}</strong>
                </div>
              </section>

              <section className="secretary-band">
                <div className="section-title"><IconAlert size={15} />门禁信号</div>
                <div className="secretary-reasons">
                  {session.gateDecision.reasons.length === 0 ? <span className="tag green">无需额外规划</span> : session.gateDecision.reasons.map((reason) => <span className="tag orange" key={reason}>{REASONS[reason] ?? reason}</span>)}
                </div>
              </section>

              {session.status === 'NEEDS_INPUT' && session.questionSet && (
                <section className="secretary-band">
                  <div className="section-title"><IconFlow size={15} />老板选择 <span className="section-sub">第 {session.questionSet.version} 轮 · {session.questionSet.questions.length} 题</span></div>
                  <div className="secretary-question-grid">
                    {session.questionSet.questions.map((question) => {
                      const draft = answers[question.id] ?? { selectedOptionIds: [], text: '' };
                      return (
                        <div className="secretary-question" key={question.id}>
                          <div className="secretary-question-prompt">{question.prompt}</div>
                          <div className="secretary-option-list">
                            {question.options.map((option) => {
                              const checked = draft.selectedOptionIds.includes(option.id);
                              return <button key={option.id} className={`secretary-option ${checked ? 'selected' : ''}`} onClick={() => toggleAnswerOption(question.id, option.id, question.kind === 'multi' ? 'multi' : 'single')} aria-pressed={checked}>
                                <span className="secretary-option-radio">{checked ? <IconCheck size={12} /> : null}</span>
                                <span><strong>{option.label}</strong><small>{option.impact}</small></span>
                              </button>;
                            })}
                          </div>
                          <input className="input secretary-other" value={draft.text} onChange={(event) => setAnswers((previous) => ({ ...previous, [question.id]: { ...draft, text: event.target.value } }))} placeholder="补充其他约束（可选）" />
                        </div>
                      );
                    })}
                  </div>
                  <div className="secretary-actions"><button className="btn primary" disabled={busy !== null} onClick={() => void answerQuestions()}><IconCheck size={14} />确认回答</button></div>
                </section>
              )}

              {(session.status === 'DRAFT' || session.status === 'REJECTED') && (
                <section className="secretary-band secretary-propose-row">
                  <div><div className="section-title"><IconFlow size={15} />生成计划</div><div className="section-sub">兼容规划器会基于当前组织内 READY 员工生成可审计基线 DAG。</div></div>
                  <button className="btn primary" disabled={busy !== null} onClick={() => void run('计划已生成', () => window.aibox.proposePlanningPlan({ sessionId: session.id, expectedRevision: session.revision }))}><IconFlow size={14} />生成新版本</button>
                </section>
              )}

              {currentPlan && <PlanPanel session={session} planVersion={currentPlan} busy={busy} onApprove={() => void run('计划已批准', () => window.aibox.approvePlanningPlan({ sessionId: session.id, expectedRevision: session.revision, version: currentPlan.version, hash: currentPlan.hash }))} onReject={() => void run('计划已拒绝', () => window.aibox.rejectPlanningPlan({ sessionId: session.id, expectedRevision: session.revision, version: currentPlan.version, hash: currentPlan.hash }))} onRepropose={() => void run('新计划版本已生成', () => window.aibox.proposePlanningPlan({ sessionId: session.id, expectedRevision: session.revision }))} onDispatch={() => void run('派工流程已处理', () => window.aibox.dispatchPlanningPlan({ sessionId: session.id, expectedRevision: session.revision, version: currentPlan.version, hash: currentPlan.hash }))} />}

              <section className="secretary-band secretary-dispatch-band">
                <div className="section-title"><IconPlay size={15} />派工状态 <span className={`tag ${session.dispatch.status === 'DISPATCHED' ? 'green' : session.dispatch.status === 'FAILED' ? 'red' : 'orange'}`}>{DISPATCH_LABEL[session.dispatch.status]}</span></div>
                <div className="secretary-dispatch-summary"><span>{session.dispatch.receipts.length}/{session.dispatch.totalNodes || 0} 个节点有 receipt</span>{session.dispatch.planHash && <code>{session.dispatch.planHash}</code>}</div>
                {session.dispatch.error && <div className="secretary-error"><IconX size={14} />{session.dispatch.error.code}: {session.dispatch.error.message}</div>}
                {session.dispatch.receipts.length > 0 && <div className="secretary-receipts">{session.dispatch.receipts.map((receipt) => <div className="secretary-receipt" key={receipt.nodeId}><span>{receipt.nodeId}</span><code>{receipt.taskId}</code><small>{formatTime(receipt.createdAt)}</small></div>)}</div>}
              </section>
            </>
          )}
        </main>
      </div>
    </div>
  );
}

function CreatePanel({ request, signals, busy, onRequest, onSignal, onCreate }: {
  request: string;
  signals: PlanningComplexitySignalsInput;
  busy: string | null;
  onRequest: (value: string) => void;
  onSignal: <K extends keyof PlanningComplexitySignalsInput>(key: K, value: PlanningComplexitySignalsInput[K]) => void;
  onCreate: () => void;
}) {
  const toggle = (key: keyof PlanningComplexitySignalsInput) => onSignal(key, !signals[key] as PlanningComplexitySignalsInput[typeof key]);
  return <section className="secretary-create">
    <div className="eyebrow">NEW PLANNING SESSION</div>
    <h3>为旧 CLI 建立计划</h3>
    <textarea className="input secretary-request" value={request} onChange={(event) => onRequest(event.target.value)} placeholder="例如：评估三个供应商并在本周交付可执行的选型建议" />
    <div className="secretary-form-grid">
      <label className="field"><span>预计时长（分钟）</span><input className="input" type="number" min={0} value={signals.estimatedDurationMinutes} onChange={(event) => onSignal('estimatedDurationMinutes', Number(event.target.value))} /></label>
      <label className="field"><span>预计费用</span><input className="input" type="number" min={0} step="0.01" value={signals.estimatedCost} onChange={(event) => onSignal('estimatedCost', Number(event.target.value))} /></label>
      <label className="field"><span>预计 token</span><input className="input" type="number" min={0} value={signals.estimatedTokenCount} onChange={(event) => onSignal('estimatedTokenCount', Number(event.target.value))} /></label>
      <label className="field"><span>任务节点数</span><input className="input" type="number" min={1} value={signals.estimatedTaskCount ?? 1} onChange={(event) => onSignal('estimatedTaskCount', Number(event.target.value))} /></label>
    </div>
    <div className="secretary-toggle-grid">
      {([
        ['hasCrossTeamDependencies', '跨团队依赖'], ['ambiguousObjective', '目标待澄清'], ['ambiguousScope', '范围待澄清'],
        ['ambiguousAcceptance', '验收待澄清'], ['requiresNewTeam', '需要新团队'], ['compareAlternatives', '比较方案'], ['phasedExecution', '分阶段执行']
      ] as Array<[keyof PlanningComplexitySignalsInput, string]>).map(([key, label]) => <button key={key} className={`chip ${signals[key] ? 'on' : ''}`} onClick={() => toggle(key)} aria-pressed={Boolean(signals[key])}>{label}</button>)}
    </div>
    <div className="secretary-create-foot"><span className="section-sub">复杂任务会先进入选择题与审批，不会直接派工。</span><button className="btn primary" disabled={!request.trim() || busy !== null} onClick={onCreate}><IconFlow size={14} />开始规划</button></div>
  </section>;
}

function PlanPanel({ session, planVersion, busy, onApprove, onReject, onRepropose, onDispatch }: {
  session: PlanningSessionView;
  planVersion: PlanningSessionView['planVersions'][number];
  busy: string | null;
  onApprove: () => void;
  onReject: () => void;
  onRepropose: () => void;
  onDispatch: () => void;
}) {
  const agentName = new Map(session.agents.map((agent) => [agent.id, agent.name]));
  const canDecide = planVersion.status === 'PROPOSED' && session.status === 'PROPOSED';
  const canDispatch = planVersion.status === 'APPROVED' && (session.status === 'APPROVED' || session.status === 'DISPATCHED');
  return <section className="secretary-band">
    <div className="section-title"><IconFlow size={15} />计划版本 <span className={`tag ${planVersion.status === 'APPROVED' ? 'green' : planVersion.status === 'REJECTED' ? 'red' : 'orange'}`}>{planVersion.status} · v{planVersion.version}</span></div>
    <div className="secretary-plan-ref"><span>SHA-256</span><code>{planVersion.hash}</code><span>创建于 {formatTime(planVersion.createdAt)}</span></div>
    <div className="secretary-version-strip" aria-label="计划版本历史">
      {session.planVersions.map((version) => <span className={`secretary-version-chip ${version.version === planVersion.version ? 'current' : ''}`} key={version.version}>v{version.version} · {version.status} · {version.hash.slice(0, 10)}</span>)}
    </div>
    <div className="secretary-plan-grid">
      <div className="secretary-plan-column"><h4>团队</h4>{planVersion.plan.team.map((team) => <div className="secretary-team" key={team.teamId}><strong>{agentName.get(team.leadAgentId) ?? team.leadAgentId}</strong><span>负责人</span><div>{team.memberAgentIds.map((id) => <span className="tag gray" key={id}>{agentName.get(id) ?? id}</span>)}</div>{team.proposedEphemeralRoles.length > 0 && <small>临时角色：{team.proposedEphemeralRoles.join('、')}</small>}</div>)}</div>
      <div className="secretary-plan-column"><h4>预算</h4><div className="secretary-budget"><div><IconClock size={14} /><span>时间</span><strong>{formatNumber(planVersion.plan.overallBudget.timeMinutes)} 分钟</strong></div><div><span>Token</span><strong>{formatNumber(planVersion.plan.overallBudget.tokenLimit)}</strong></div><div><span>费用</span><strong>{formatNumber(planVersion.plan.overallBudget.costLimit)}</strong></div></div><h4>验收</h4><ul>{planVersion.plan.acceptanceCriteria.map((item) => <li key={item}>{item}</li>)}</ul></div>
    </div>
    <div className="secretary-dag"><h4>DAG 执行节点</h4>{planVersion.plan.dag.map((node, index) => <div className="secretary-dag-node" key={node.nodeId}><div className="secretary-dag-index">{index + 1}</div><div className="secretary-dag-content"><strong>{node.nodeId} · {agentName.get(node.ownerAgentId) ?? node.ownerAgentId}</strong><p>{node.workOrder}</p><div className="secretary-dag-meta"><span>依赖：{node.dependencies.length ? node.dependencies.join(', ') : '无'}</span><span>预算 {node.budget.timeMinutes}m / {node.budget.tokenLimit} token</span><span>验收：{node.acceptanceCriteria.join('；')}</span></div></div></div>)}</div>
    {(canDecide || canDispatch || (session.status === 'APPROVED' && session.dispatch.status === 'NOT_STARTED')) && <div className="secretary-actions">{canDecide && <button className="btn danger" disabled={busy !== null} onClick={onReject}><IconX size={14} />拒绝版本</button>}{canDecide && <button className="btn primary" disabled={busy !== null} onClick={onApprove}><IconCheck size={14} />批准 v{planVersion.version}</button>}{session.status === 'APPROVED' && session.dispatch.status === 'NOT_STARTED' && <button className="btn" disabled={busy !== null} onClick={onRepropose}><IconFlow size={14} />生成新版本</button>}{canDispatch && <button className="btn primary" disabled={busy !== null || session.dispatch.status === 'IN_PROGRESS'} onClick={onDispatch}><IconPlay size={14} />{session.dispatch.status === 'PARTIAL' || session.dispatch.status === 'FAILED' ? '重试派工' : '派工'}</button>}</div>}
  </section>;
}

export default SecretaryPlanning;
