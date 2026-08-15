/**
 * 首次启动种子数据：与产品基准 UI 一致的演示环境
 * （3 个项目；12 数字员工 = 8 执行中 + 4 空闲/待命；今日完成 23 项；待办 8 项）
 * + 常用 MCP 服务器预置 + 常用技能预置
 */
import { randomUUID } from 'node:crypto';
import type { Database } from './database.js';
import { NEXUS_ENGINE_ID } from '../../shared/types.js';

// ==================== 常用 MCP 服务器预置 ====================

interface SeedMcpServer {
  name: string;
  command: string;
  args: string[];
  env: Record<string, string>;
  scope: string;
  capability?: 'browser';
}

const SEED_MCP_SERVERS: SeedMcpServer[] = [
  {
    name: '文件系统',
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-filesystem', 'E:/AIBox/workspaces'],
    env: {},
    scope: 'global'
  },
  {
    name: '网页抓取',
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-fetch'],
    env: {},
    scope: 'global'
  },
  {
    name: '知识图谱记忆',
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-memory'],
    env: {},
    scope: 'global'
  },
  {
    name: '结构化思考',
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-sequential-thinking'],
    env: {},
    scope: 'global'
  },
  {
    name: 'SQLite 数据库',
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-sqlite', '--db-path', 'E:/AIBox/data/business.db'],
    env: {},
    scope: 'global'
  },
  {
    name: 'GitHub',
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-github'],
    env: { GITHUB_PERSONAL_ACCESS_TOKEN: '<YOUR_TOKEN>' },
    scope: 'global'
  },
  {
    name: 'Brave 搜索',
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-brave-search'],
    env: { BRAVE_API_KEY: '<YOUR_KEY>' },
    scope: 'global'
  },
  {
    name: '浏览器自动化',
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-puppeteer'],
    env: {},
    scope: 'global',
    capability: 'browser'
  }
];

// ==================== 常用技能预置 ====================

interface SeedSkill {
  name: string;
  description: string;
  content: string;
}

const SEED_SKILLS: SeedSkill[] = [
  {
    name: '代码审查',
    description: '对代码变更进行结构化审查，识别安全漏洞、性能问题和代码规范违规',
    content: `## 代码审查技能\n\n### 审查维度\n- **安全性**：SQL 注入、XSS、敏感信息泄露、权限绕过\n- **性能**：N+1 查询、内存泄漏、不必要的重复计算\n- **可维护性**：命名规范、函数复杂度、重复代码\n- **正确性**：边界条件、空值处理、并发安全\n\n### 输出格式\n按严重程度排序：🔴 严重 → 🟡 警告 → 🔵 建议\n每条包含：位置、问题描述、修复建议、示例代码`
  },
  {
    name: '日报/周报生成',
    description: '汇总当日/当周工作进展，自动生成结构化日报或周报',
    content: `## 日报/周报生成技能\n\n### 输入\n- 今日完成的任务列表\n- 遇到的问题与阻塞\n- 明日/下周计划\n\n### 输出模板\n\`\`\`\n【日报】{日期}\n\n✅ 已完成：\n1. ...\n2. ...\n\n⚠️ 问题/阻塞：\n- ...\n\n📋 明日计划：\n1. ...\n2. ...\n\`\`\`\n\n### 要求\n- 语言简洁、重点突出\n- 量化成果（完成了X项、处理了Y条）\n- 阻塞项标注责任人和预期解决时间`
  },
  {
    name: '数据分析报告',
    description: '对业务数据进行多维度分析，生成含图表建议的分析报告',
    content: `## 数据分析报告技能\n\n### 分析流程\n1. 明确分析目标与关键指标\n2. 数据清洗与异常值识别\n3. 多维度交叉分析（时间/部门/产品线）\n4. 趋势判断与归因分析\n5. 结论与建议\n\n### 输出结构\n- 📊 核心指标概览（同比/环比）\n- 📈 趋势分析（附推荐图表类型）\n- 🔍 异常点说明\n- 💡 改进建议（可执行的 action items）\n\n### 要求\n- 数据引用需标注来源和时间范围\n- 结论需有数据支撑，避免主观臆断\n- 建议按优先级排序`
  },
  {
    name: '邮件/公文写作',
    description: '根据场景生成正式邮件、通知、公告等商务文书',
    content: `## 邮件/公文写作技能\n\n### 适用场景\n- 商务邮件（客户沟通、合作洽谈）\n- 内部通知（制度变更、活动安排）\n- 工作汇报（项目进展、问题升级）\n- 邀请函/感谢信\n\n### 写作原则\n- 主题明确，一段一义\n- 称呼得体，语气匹配场景\n- 行动项清晰（谁、做什么、何时）\n- 结尾礼貌，附必要附件说明\n\n### 输出\n提供 2-3 个版本（正式/半正式/简洁），由用户选择`
  },
  {
    name: '会议纪要整理',
    description: '将会议录音/文字记录整理为结构化纪要，提取待办并分配责任人',
    content: `## 会议纪要整理技能\n\n### 输入\n- 会议录音转写文本 或 手动记录\n\n### 输出结构\n\`\`\`\n【会议纪要】\n主题：{会议主题}\n时间：{日期 时间}\n参会人：{人员列表}\n\n一、议题与讨论要点\n  1. ...\n  2. ...\n\n二、决议事项\n  - ...\n\n三、待办跟踪\n  | 事项 | 责任人 | 截止日期 |\n  |------|--------|----------|\n  | ... | ... | ... |\n\n四、下次会议安排\n\`\`\`\n\n### 要求\n- 过滤寒暄和重复内容\n- 决议需明确、可执行\n- 待办必须有责任人和时间`
  },
  {
    name: 'SQL 查询助手',
    description: '根据自然语言描述生成 SQL 查询，支持解释和优化建议',
    content: `## SQL 查询助手技能\n\n### 能力\n- 自然语言 → SQL 转换\n- 复杂查询拆解（JOIN/子查询/窗口函数）\n- 查询性能优化建议\n- 结果解读与可视化建议\n\n### 输出格式\n1. 生成的 SQL（带注释）\n2. 逻辑说明（每步做了什么）\n3. 性能提示（索引建议/避免全表扫描）\n4. 预期结果示例\n\n### 约束\n- 默认只生成 SELECT 查询\n- 涉及写操作需明确标注风险\n- 大表查询必须带 LIMIT`
  },
  {
    name: '文档翻译与润色',
    description: '中英文档互译、技术文档润色，保持专业术语一致性',
    content: `## 文档翻译与润色技能\n\n### 翻译模式\n- 中→英 / 英→中\n- 技术文档（保留代码/术语不翻译）\n- 商务文档（本地化表达）\n\n### 润色模式\n- 语法纠错\n- 表达优化（去冗余、增强逻辑连贯性）\n- 术语统一（同一概念全文一致）\n- 格式规范化\n\n### 输出\n- 翻译/润色后全文\n- 修改说明（重大改动处标注原因）\n- 术语对照表（如有必要）`
  },
  {
    name: '故障排查',
    description: '系统化排查系统/应用故障，输出诊断报告和修复方案',
    content: `## 故障排查技能\n\n### 排查流程\n1. **现象确认**：错误信息、影响范围、发生时间\n2. **日志分析**：关键错误日志、异常堆栈\n3. **变更回溯**：近期部署/配置变更\n4. **隔离定位**：网络/服务/数据/资源逐层排查\n5. **根因确认**：复现验证\n\n### 输出结构\n\`\`\`\n【故障诊断报告】\n现象：...\n影响：...\n根因：...\n修复方案：\n  方案A（推荐）：...\n  方案B（备选）：...\n预防措施：...\n\`\`\`\n\n### 要求\n- 每步记录排查命令和结果\n- 修复方案需评估风险\n- 给出预防复发的建议`
  },
  {
    name: 'PDF 文档处理',
    description: '解析、提取、合并、拆分 PDF 文档，支持表格/图片/文本结构化提取',
    content: `## PDF 文档处理技能\n\n### 能力范围\n- **文本提取**：从 PDF 中提取纯文本，保留段落结构\n- **表格识别**：识别 PDF 中的表格并转为结构化数据（CSV/JSON）\n- **图片提取**：导出 PDF 内嵌图片\n- **合并/拆分**：多 PDF 合并、按页拆分\n- **格式转换**：PDF → Word/Markdown/HTML\n- **信息摘要**：长文档自动生成摘要\n\n### 工具链\n- Python: PyMuPDF(fitz) / pdfplumber / PyPDF2\n- Node: pdf-parse / pdf-lib\n- CLI: qpdf / pdftotext\n\n### 输出规范\n- 提取文本保留原始段落编号\n- 表格输出为 Markdown 表格或 CSV\n- 标注页码来源便于溯源\n- 扫描件需提示用户启用 OCR`
  },
  {
    name: 'Word 文档生成',
    description: '根据模板或自然语言生成 Word(.docx) 文档，支持格式排版和批量生成',
    content: `## Word 文档生成技能\n\n### 能力范围\n- **文档生成**：根据内容大纲生成带格式的 .docx\n- **模板填充**：基于 Word 模板批量替换变量生成文档\n- **格式排版**：标题层级、页眉页脚、目录、页码\n- **内容改写**：对已有 Word 内容进行润色/扩写/缩写\n- **格式转换**：Markdown/HTML → Word\n\n### 工具链\n- Python: python-docx / docxtpl（模板引擎）\n- Node: docx / officegen\n- 模板变量语法：{{变量名}}\n\n### 排版规范\n- 标题：一级标题 16pt 加粗，二级 14pt，三级 12pt\n- 正文：宋体/微软雅黑 11pt，行距 1.5 倍\n- 页边距：上下 2.54cm，左右 3.17cm\n- 表格：带边框，表头加粗灰底\n\n### 输出\n- 生成文件路径\n- 文档结构大纲预览\n- 如需用户确认的内容标注高亮`
  },
  {
    name: 'Excel 数据处理',
    description: '读写 Excel 文件，数据清洗、公式生成、图表建议与报表自动化',
    content: `## Excel 数据处理技能\n\n### 能力范围\n- **数据读取**：解析 .xlsx/.csv，识别表头与数据类型\n- **数据清洗**：去重、空值填充、格式统一、异常值标记\n- **公式生成**：根据需求生成 VLOOKUP/SUMIFS/INDEX-MATCH 等公式\n- **透视分析**：按维度汇总，生成透视表结构建议\n- **图表推荐**：根据数据特征推荐合适图表类型\n- **报表生成**：自动生成带格式的 Excel 报表\n- **宏/VBA**：编写自动化宏代码\n\n### 工具链\n- Python: openpyxl / pandas / xlsxwriter\n- Node: exceljs / xlsx(SheetJS)\n\n### 输出规范\n- 数据预览（前 10 行）\n- 清洗/转换逻辑说明\n- 公式附带中文注释\n- 大文件（>10万行）提示分块处理\n- 生成文件注明 sheet 命名和列含义`
  },
  {
    name: 'PPT 演示制作',
    description: '根据主题/大纲自动生成 PPT 演示文稿，支持排版设计和内容组织',
    content: `## PPT 演示制作技能\n\n### 能力范围\n- **大纲生成**：根据主题生成演示逻辑大纲\n- **内容编排**：每页标题 + 要点（不超过 5 条）\n- **演讲稿**：为每页生成配套演讲备注\n- **设计建议**：配色方案、版式布局、字体搭配\n- **文件生成**：输出 .pptx 文件\n\n### 工具链\n- Python: python-pptx\n- Node: pptxgenjs / officegen\n\n### 设计原则\n- 每页一个核心观点\n- 文字精简：标题 ≤ 10 字，要点 ≤ 15 字/条\n- 数据用图表代替文字堆砌\n- 配色不超过 3 种主色\n- 留白充足，避免信息过载\n\n### 输出结构\n1. 演示大纲（逻辑线）\n2. 逐页内容（标题 + 要点 + 备注）\n3. 设计建议（配色/版式/动画）\n4. 生成 .pptx 文件路径`
  },
  {
    name: 'OCR 文字识别',
    description: '从图片、扫描件、截图中识别提取文字，支持表格和多语言',
    content: `## OCR 文字识别技能\n\n### 能力范围\n- **图片文字提取**：截图、照片中的文字识别\n- **扫描件处理**：PDF 扫描件 → 可编辑文本\n- **表格识别**：图片中的表格 → 结构化数据\n- **多语言**：中文/英文/日文/韩文混合识别\n- **手写体**：基础手写文字识别（准确率有限需人工校验）\n\n### 工具链\n- Python: PaddleOCR / Tesseract / EasyOCR\n- 在线API：百度OCR / 腾讯OCR / Azure Vision\n\n### 处理流程\n1. 图片预处理（去噪、倾斜校正、对比度增强）\n2. 文字区域检测\n3. 文字识别 + 置信度标注\n4. 后处理（纠错、格式还原）\n\n### 输出规范\n- 识别文本（保留原始排版）\n- 低置信度文字用 [?] 标注\n- 表格输出为 Markdown/CSV\n- 注明识别引擎和置信度均值`
  },
  {
    name: '文件格式转换',
    description: '支持 PDF/Word/Excel/PPT/Markdown/HTML 等格式间互转',
    content: `## 文件格式转换技能\n\n### 支持转换矩阵\n| 源格式 | 目标格式 |\n|--------|----------|\n| PDF | Word / Markdown / HTML / TXT / 图片 |\n| Word | PDF / HTML / Markdown |\n| Excel | CSV / JSON / PDF / HTML 表格 |\n| PPT | PDF / 图片 / 大纲文本 |\n| Markdown | PDF / Word / HTML / PPT |\n| HTML | PDF / Word / Markdown |\n| 图片 | PDF（合并）/ OCR 文本 |\n\n### 工具链\n- Pandoc（万能文档转换）\n- LibreOffice CLI（Office 格式互转）\n- Python: pdf2docx / docx2pdf / markdown-pdf\n- Node: md-to-pdf / html-docx-js\n\n### 转换原则\n- 保留原始格式层级（标题/列表/表格）\n- 图片内嵌或导出为附件\n- 转换后校验：页数/字数/结构一致性\n- 不可逆转换（如 PPT→TXT）提前告知信息损失`
  }
];

/** 预置 MCP 服务器（表为空时写入） */
export function seedMcpServers(db: Database) {
  const count = (db.raw.prepare('SELECT COUNT(*) c FROM mcp_servers').get() as { c: number }).c;
  if (count > 0) return;

  db.transaction(() => {
    const insert = db.raw.prepare(
      'INSERT INTO mcp_servers(id, name, command, args, env, enabled, scope, capability) VALUES(?,?,?,?,?,1,?,?)'
    );
    for (const s of SEED_MCP_SERVERS) {
      insert.run(`mcp-${randomUUID().slice(0, 8)}`, s.name, s.command, JSON.stringify(s.args), JSON.stringify(s.env), s.scope, s.capability ?? '');
    }
  });
}

/** 预置常用技能（表为空时写入） */
export function seedSkills(db: Database) {
  const count = (db.raw.prepare('SELECT COUNT(*) c FROM skills').get() as { c: number }).c;
  if (count > 0) return;

  const now = Date.now();
  db.transaction(() => {
    const insert = db.raw.prepare(
      'INSERT INTO skills(id, name, description, content, enabled, created_at) VALUES(?,?,?,?,1,?)'
    );
    for (const s of SEED_SKILLS) {
      insert.run(`skill-${randomUUID().slice(0, 8)}`, s.name, s.description, s.content, now);
    }
  });
}

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

const DEMO_PROJECTS = [
  {
    id: 'project-demo-operations', name: '经营自动化一期', objective: '打通财务、生产、采购与经营数据的例行自动化',
    description: '优先覆盖高频、可量化、可复用的经营流程。', clientName: '内部运营', status: 'active', color: '#4d6bfe', dueDays: 14
  },
  {
    id: 'project-demo-quality', name: '交付质量提升', objective: '建立测试、文档、品质与运维的交付检查闭环',
    description: '统一质量记录、异常跟进和验收标准。', clientName: '交付中心', status: 'active', color: '#22c1a3', dueDays: 5
  },
  {
    id: 'project-demo-customer', name: '客户协同标准化', objective: '沉淀招聘、销售、合同与会议协同标准流程',
    description: '形成可复用的客户与组织协同模板。', clientName: '业务团队', status: 'completed', color: '#f59e0b', dueDays: -2
  }
] as const;

function demoProjectForAgent(agentName: string): string {
  if (['ERP/CRM助手', 'MES助手', '采购比价助手', '数据分析助手'].includes(agentName)) return 'project-demo-operations';
  if (['测试验证助手', '文档助手', '品质管理助手', 'IT运维助手'].includes(agentName)) return 'project-demo-quality';
  return 'project-demo-customer';
}

function demoTaskResult(agentName: string, sequence: number): string {
  const focus: Record<string, string> = {
    'ERP/CRM助手': '完成应收应付核对，未发现阻断项，已整理异常单据清单。',
    'MES助手': '汇总产线工单数据，识别 2 项进度偏差并给出处置建议。',
    '测试验证助手': '完成回归测试报告，核心流程通过，遗留问题已分级记录。',
    '文档助手': '完成文档归档与索引更新，变更记录可追溯。',
    '人事招聘助手': '更新候选人阶段与面试安排，待跟进事项已明确责任人。',
    '品质管理助手': '完成品质数据统计，异常趋势和复核项已列入报告。',
    '采购比价助手': '完成供应商报价数据对比，形成推荐顺序与风险说明。',
    'IT运维助手': '完成系统巡检报告，服务可用性正常，容量风险已标注。',
    '销售外勤助手': '整理客户拜访纪要，关键需求和下一步行动已结构化。',
    '合同审核助手': '完成合同条款审查，风险条款与修订建议已归纳。',
    '数据分析助手': '完成经营数据分析报告，核心指标和趋势结论已输出。',
    '会议纪要助手': '完成会议纪要，决议、责任人和截止时间已提取。'
  };
  return `# ${agentName}例行成果 #${sequence}\n\n## 完成摘要\n\n${focus[agentName] ?? '例行工作已完成，结果与后续事项已整理。'}\n\n## 后续事项\n\n- 结果已归档，等待验收\n- 异常项进入下一轮跟进\n`;
}

/**
 * 首次启动种子数据。
 *
 * 【默认不写入】演示数据（12 员工 / 23 条已完成任务 / 8 待审批 / 3 项目）会与真实数据
 * 共用同一批表，若无标记则统计口径无法区分真伪。因此：
 *  - 默认跳过，新装用户看到干净的空状态；
 *  - 仅当 settings.seedDemoData 显式为 true 时写入，且所有行标记 is_demo = 1；
 *  - 首页统计与项目经营分析一律排除 is_demo 行（见 orchestrator.stats）。
 * 需要演示环境时在设置页开启，或调用 purgeDemoData 清空。
 */
export function seedIfEmpty(db: Database) {
  if (db.getSetting<boolean>('seedDemoData', false) !== true) return;
  const count = (db.raw.prepare('SELECT COUNT(*) c FROM agents').get() as { c: number }).c;
  if (count > 0) return;

  const now = Date.now();
  const todayStart = new Date(); todayStart.setHours(0, 0, 0, 0);

  db.transaction(() => {
    const insertProject = db.raw.prepare(
      'INSERT INTO projects(id, name, objective, description, client_name, status, color, due_at, created_at, updated_at, is_demo) VALUES(?,?,?,?,?,?,?,?,?,?,1)'
    );
    for (const project of DEMO_PROJECTS) {
      insertProject.run(
        project.id, project.name, project.objective, project.description, project.clientName, project.status, project.color,
        now + project.dueDays * 86_400_000, now - 7 * 86_400_000, now
      );
    }
    const insertAgent = db.raw.prepare(
      `INSERT INTO agents(id, name, role, system_prompt, lifecycle, engine_id, workspace, permission_mode, concurrency_limit, archived, avatar_color, created_at, updated_at, is_demo)
       VALUES(?, ?, ?, ?, 'READY', '${NEXUS_ENGINE_ID}', ?, 'standard', 1, 0, ?, ?, ?, 1)`
    );
    const insertTask = db.raw.prepare(
      `INSERT INTO tasks(id, agent_id, project_id, title, source, parent_id, status, priority, progress, stage, error, created_at, started_at, ended_at, result, is_demo)
       VALUES(?, ?, ?, ?, 'desktop', NULL, ?, 0, ?, ?, NULL, ?, ?, ?, ?, 1)`
    );
    const insertRun = db.raw.prepare(
      `INSERT INTO agent_runs(id, agent_id, task_id, pid, session_id, status, started_at, ended_at) VALUES(?, ?, ?, ?, ?, ?, ?, ?)`
    );
    const insertApproval = db.raw.prepare(
      `INSERT INTO approvals(id, task_id, agent_id, type, request, risk, status, created_at, decided_at) VALUES(?, ?, ?, ?, ?, ?, 'pending', ?, NULL)`
    );

    const agentIds = new Map<string, string>();
    const activeTaskIds = new Map<string, string>();

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
        activeTaskIds.set(a.name, tid);
        insertTask.run(tid, id, demoProjectForAgent(a.name), a.task.title, 'RUNNING', a.task.progress, '执行中', now - 3600_000, now - 3600_000, null, null);
        insertRun.run(randomUUID(), id, tid, process.pid, randomUUID(), 'RUNNING', now - 3600_000, null);
      }
    }

    // 今日已完成 23 项（分布在各员工上）
    const names = AGENTS.map((a) => a.name);
    for (let i = 0; i < 23; i++) {
      const agentId = agentIds.get(names[i % names.length])!;
      const ended = todayStart.getTime() + 3600_000 + i * 900_000;
      insertTask.run(
        randomUUID(), agentId, demoProjectForAgent(names[i % names.length]), `例行任务 #${i + 1}`, 'COMPLETED', 100, '完成',
        ended - 600_000, ended - 600_000, ended, demoTaskResult(names[i % names.length], i + 1)
      );
    }

    // 8 项待审批（首页"待处理待办 8 项"）
    for (const ap of TODO_APPROVALS) {
      const agentId = agentIds.get(ap.agent)!;
      const taskId = activeTaskIds.get(ap.agent);
      if (!taskId) throw new Error(`演示审批缺少关联任务：${ap.agent}`);
      insertApproval.run(randomUUID(), taskId, agentId, 'write_workspace', ap.title, ap.risk, now - 1800_000);
    }
  });

  db.audit({ id: randomUUID(), actor: 'system', action: 'seed.demo', target: '12 agents / 8 approvals', result: 'ok' });
}

/** 演示数据统计：供设置页展示「当前库中有多少演示数据」 */
export function demoDataStats(db: Database): { agents: number; tasks: number; projects: number } {
  const count = (sql: string) => (db.raw.prepare(sql).get() as { c: number }).c;
  return {
    agents: count('SELECT COUNT(*) c FROM agents WHERE is_demo = 1'),
    tasks: count('SELECT COUNT(*) c FROM tasks WHERE is_demo = 1'),
    projects: count('SELECT COUNT(*) c FROM projects WHERE is_demo = 1')
  };
}

/**
 * 清空演示数据（H-3）：删除所有 is_demo = 1 的员工/任务/项目及其派生记录。
 * 只删标记为演示的行，真实数据不受影响；外键顺序从叶子表向主表删除。
 */
export function purgeDemoData(db: Database): { agents: number; tasks: number; projects: number } {
  const before = demoDataStats(db);
  db.transaction(() => {
    const demoTasks = 'SELECT id FROM tasks WHERE is_demo = 1';
    const demoAgents = 'SELECT id FROM agents WHERE is_demo = 1';
    // 任务派生记录
    db.raw.prepare(`DELETE FROM task_events WHERE task_id IN (${demoTasks})`).run();
    db.raw.prepare(`DELETE FROM task_messages WHERE task_id IN (${demoTasks})`).run();
    db.raw.prepare(`DELETE FROM agent_runs WHERE task_id IN (${demoTasks})`).run();
    db.raw.prepare(`DELETE FROM usage_records WHERE task_id IN (${demoTasks})`).run();
    // 审批与员工派生记录（种子审批的 task_id 为随机值，按 agent 清理）
    db.raw.prepare(`DELETE FROM approvals WHERE agent_id IN (${demoAgents})`).run();
    db.raw.prepare(`DELETE FROM agent_runs WHERE agent_id IN (${demoAgents})`).run();
    db.raw.prepare(`DELETE FROM agent_skills WHERE agent_id IN (${demoAgents})`).run();
    db.raw.prepare(`DELETE FROM conversations WHERE agent_id IN (${demoAgents})`).run();
    db.raw.prepare(`DELETE FROM channel_routes WHERE agent_id IN (${demoAgents})`).run();
    // 主表
    db.raw.prepare('DELETE FROM tasks WHERE is_demo = 1').run();
    db.raw.prepare('DELETE FROM agents WHERE is_demo = 1').run();
    db.raw.prepare('DELETE FROM projects WHERE is_demo = 1').run();
  });
  db.audit({
    id: randomUUID(), actor: 'admin', action: 'seed.purgeDemo',
    target: `${before.agents} agents / ${before.tasks} tasks / ${before.projects} projects`, result: 'ok'
  });
  return before;
}
