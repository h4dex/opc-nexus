import { describe, expect, it } from 'vitest';
import { evaluatePlanningGate } from '../src/main/services/secretaryPlanning.js';
import {
  classifySecretaryPlanningRequest,
  SECRETARY_PLANNING_CLASSIFIER_LIMITS
} from '../src/main/services/secretaryPlanningClassifier.js';

describe('classifySecretaryPlanningRequest', () => {
  it.each([
    '',
    '你好',
    'React 的 useMemo 是什么？',
    '请解释一下跨团队协作的含义',
    '请比较 TCP 和 UDP 的区别',
    '请写一个 TypeScript 函数，将两个数字相加'
  ])('keeps an ordinary short request out of planning: %s', (request) => {
    expect(classifySecretaryPlanningRequest(request)).toBeNull();
  });

  it('detects cross-team and new-team execution', () => {
    const signals = classifySecretaryPlanningRequest(
      '请组建一个临时团队，让产品、研发和测试跨部门协同，端到端交付完整平台。'
    );
    expect(signals).toMatchObject({
      departmentIds: ['primary', 'collaborating'],
      hasCrossTeamDependencies: true,
      requiresNewTeam: true
    });
    expect(signals?.estimatedTaskCount).toBeGreaterThanOrEqual(6);
  });

  it('detects alternatives, confirmation, and phased execution', () => {
    const signals = classifySecretaryPlanningRequest(
      '请先给我三个实施方案做比较，等我确认后再分阶段执行系统迁移。'
    );
    expect(signals).toMatchObject({
      compareAlternatives: true,
      confirmBeforeExecution: true,
      phasedExecution: true
    });
  });

  it('parses explicit long duration and clamps it to the deterministic bound', () => {
    const signals = classifySecretaryPlanningRequest('请构建完整系统，这是持续 9999 天的长任务。');
    expect(signals?.estimatedDurationMinutes).toBe(SECRETARY_PLANNING_CLASSIFIER_LIMITS.durationMinutes);
  });

  it('maps irreversible execution phrases in stable enum order', () => {
    const signals = classifySecretaryPlanningRequest(
      '请批量修改项目文件，安装依赖，部署到生产环境，通知客户，付款购买服务，删除旧数据并公开发布公告。'
    );
    expect(signals?.irreversibleOperations).toEqual([
      'write_files',
      'install_software',
      'send_external_message',
      'production_change',
      'payment',
      'delete_data',
      'publish'
    ]);
  });

  it('is deterministic and keeps every estimate within a hard bound', () => {
    const request = `请设计端到端完整平台，并且分阶段执行，然后跨团队交付。${'范围说明 '.repeat(20_000)}`;
    const first = classifySecretaryPlanningRequest(request);
    const second = classifySecretaryPlanningRequest(request);
    expect(second).toEqual(first);
    expect(first).not.toBeNull();
    expect(first!.estimatedDurationMinutes).toBeLessThanOrEqual(SECRETARY_PLANNING_CLASSIFIER_LIMITS.durationMinutes);
    expect(first!.estimatedCost).toBeLessThanOrEqual(SECRETARY_PLANNING_CLASSIFIER_LIMITS.estimatedCost);
    expect(first!.estimatedTokenCount).toBeLessThanOrEqual(SECRETARY_PLANNING_CLASSIFIER_LIMITS.estimatedTokenCount);
    expect(first!.estimatedTaskCount).toBeLessThanOrEqual(SECRETARY_PLANNING_CLASSIFIER_LIMITS.estimatedTaskCount);
  });

  it.each([
    '请先给出计划，等我确认后再执行。',
    '请比较三种技术方案并给出选型建议。',
    '请让多个团队分阶段完成这项迁移。',
    '请删除旧数据库中的数据。'
  ])('always produces signals that enter a non-empty QuestionSet path: %s', (request) => {
    const signals = classifySecretaryPlanningRequest(request);
    expect(signals).not.toBeNull();
    const decision = evaluatePlanningGate(signals!);
    expect(decision.requiresPlanning).toBe(true);
    expect(decision.reasons).toContain('LONG_TASK');
    expect(decision.complexityScore).toBeGreaterThanOrEqual(2);
  });
});
