/**
 * 首次启动种子数据：与产品基准 UI 一致的演示环境
 * （12 数字员工 = 8 执行中 + 4 空闲/待命；今日完成 23 项；待办 8 项）
 */
import { randomUUID } from 'node:crypto';
import type { Database } from './database.js';

interface SeedAgent {
  name: string; role: string; color: string;
  task?: { title: string; progress: number; owner: string };
}

const AGENTS: SeedAgent[] = [
  { name: 'ERP/CRM助手', role: '负责财务红冲发票提醒、应收应付对账与 CRM 客户资料同步，保障财务业务流转及时准确。', color: '#4d6bfe', task: { title: '财务红冲发票提醒', progress: 72, owner: '张财务' } },
  { name: 'MES助手', role: '对接生产执行系统，维护生产流程看板，跟踪工单进度与产线异常，及时推送预警信息。', color: '#3aa7ff', task: { title: '生产流程看板', progress: 48, owner: '李生产' } },
  { name: '测试验证助手', role: '执行自动化测试验证流程，整理测试报告，对回归缺陷进行归类并跟踪修复验证进度。', color: '#22c1a3' },
  { name: '文档助手', role: '负责企业文档的整理与归档，识别重要文件变更，维护知识库索引与版本可追溯性。', color: '#f59e0b', task: { title: '文档整理与归档', progress: 85, owner: '赵品质' } },
  { name: '人事招聘助手', role: '筛选简历、安排面试日程并同步候选人状态，维护招聘流程看板与人才库信息更新。', color: '#8a5cf6', task: { title: '企业内部线上学习平台', progress: 30, owner: '王人事' } },
  { name: '品质管理助手', role: '替代 A4 纸质表单完成品质记录电子化，自动汇总检验数据并生成品质趋势分析报告。', color: '#ef6a6a', task: { title: '品质记录本替代A4表单', progress: 56, owner: '赵品质' } },
  { name: '采购比价助手', role: '定期采集供应商报价并生成比价分析，跟踪采购订单交付进度与到货异常情况。', color: '#0ea5e9', task: { title: '供应商季度比价分析', progress: 40, owner: '钱采购' } },
  { name: 'IT运维助手', role: '监控内部系统运行状态，处理常见运维工单，执行例行巡检并输出健康检查报告。', color: '#10b981', task: { title: '服务器例行巡检', progress: 64, owner: '孙运维' } },
  { name: '销售外勤助手', role: '汇总外勤拜访记录，同步客户跟进状态，生成每日销售简报并提醒关键商机跟进。', color: '#f97316', task: { title: '客户拜访纪要归档', progress: 22, owner: '周销售' } },
  { name: '合同审核助手', role: '对采购与销售合同进行条款初审，识别风险条款并给出修订建议，跟踪审批流转。', color: '#a855f7' },
  { name: '数据分析助手', role: '定期汇总经营数据生成分析报表，支持多维度数据查询与可视化图表自动生成。', color: '#14b8a6' },
  { name: '会议纪要助手', role: '整理线上会议录音与纪要，提取待办事项并分配到责任人，跟踪事项闭环情况。', color: '#64748b' }
];

const TODO_APPROVALS = [
  { title: '财务红冲发票提醒：需要写入 ERP 工作目录授权', agent: 'ERP/CRM助手', risk: 'high' },
  { title: '生产流程看板：访问 MES 数据库只读凭据确认', agent: 'MES助手', risk: 'medium' },
  { title: '企业内部线上学习平台：新增课程发布审批', agent: '人事招聘助手', risk: 'medium' },
  { title: '品质记录本替代A4表单：删除历史草稿表单', agent: '品质管理助手', risk: 'high' },
  { title: '文档整理与归档：访问共享盘目录外路径审批', agent: '文档助手', risk: 'medium' },
  { title: '供应商季度比价分析：外发邮件含报价附件确认', agent: '采购比价助手', risk: 'medium' },
  { title: '服务器例行巡检：执行重启服务命令审批', agent: 'IT运维助手', risk: 'high' },
  { title: '客户拜访纪要归档：网络访问 CRM 接口域名首授权', agent: '销售外勤助手', risk: 'low' }
];

export function seedIfEmpty(db: Database) {
  const count = (db.raw.prepare('SELECT COUNT(*) c FROM agents').get() as { c: number }).c;
  if (count > 0) return;

  const now = Date.now();
  const todayStart = new Date(); todayStart.setHours(0, 0, 0, 0);

  db.transaction(() => {
    const insertAgent = db.raw.prepare(
      `INSERT INTO agents(id, name, role, system_prompt, lifecycle, engine_id, workspace, permission_mode, concurrency_limit, archived, avatar_color, created_at, updated_at)
       VALUES(?, ?, ?, ?, 'READY', 'eng-hermes', ?, 'standard', 1, 0, ?, ?, ?)`
    );
    const insertTask = db.raw.prepare(
      `INSERT INTO tasks(id, agent_id, title, source, parent_id, status, priority, progress, stage, error, created_at, started_at, ended_at)
       VALUES(?, ?, ?, 'desktop', NULL, ?, 0, ?, ?, NULL, ?, ?, ?)`
    );
    const insertRun = db.raw.prepare(
      `INSERT INTO agent_runs(id, agent_id, task_id, pid, session_id, status, started_at, ended_at) VALUES(?, ?, ?, ?, ?, ?, ?, ?)`
    );
    const insertApproval = db.raw.prepare(
      `INSERT INTO approvals(id, task_id, agent_id, type, request, risk, status, created_at, decided_at) VALUES(?, ?, ?, ?, ?, ?, 'pending', ?, NULL)`
    );

    const agentIds = new Map<string, string>();

    for (const a of AGENTS) {
      const id = randomUUID();
      agentIds.set(a.name, id);
      insertAgent.run(
        id, a.name, a.role,
        `你是「${a.name}」。${a.role}严格遵守工作目录边界与审批策略，输出结构化结果。`,
        `E:/AIBox/workspaces/${a.name}`, a.color, now - 7 * 86400_000, now
      );
      if (a.task) {
        const tid = randomUUID();
        insertTask.run(tid, id, a.task.title, 'RUNNING', a.task.progress, '执行中', now - 3600_000, now - 3600_000, null);
        insertRun.run(randomUUID(), id, tid, process.pid, randomUUID(), 'RUNNING', now - 3600_000, null);
      }
    }

    // 今日已完成 23 项（分布在各员工上）
    const names = AGENTS.map((a) => a.name);
    for (let i = 0; i < 23; i++) {
      const agentId = agentIds.get(names[i % names.length])!;
      const ended = todayStart.getTime() + 3600_000 + i * 900_000;
      insertTask.run(randomUUID(), agentId, `例行任务 #${i + 1}`, 'COMPLETED', 100, '完成', ended - 600_000, ended - 600_000, ended);
    }

    // 8 项待审批（首页"待处理待办 8 项"）
    for (const ap of TODO_APPROVALS) {
      const agentId = agentIds.get(ap.agent)!;
      insertApproval.run(randomUUID(), randomUUID(), agentId, 'write_workspace', ap.title, ap.risk, now - 1800_000);
    }
  });

  db.audit({ id: randomUUID(), actor: 'system', action: 'seed.demo', target: '12 agents / 8 approvals', result: 'ok' });
}
