/**
 * 阿里云 RPC 签名算法测试
 *
 * 为什么需要:取令牌链路依赖真实凭据,无法在 CI 中端到端验证;
 * 而签名算错的表现是 403,排查成本高。这里用可离线校验的性质锁住实现:
 * - RFC3986 编码规则(encodeURIComponent 不满足规范,需纠正三处)
 * - StringToSign 的构造格式(与官方文档《签名机制》示例逐字节比对)
 * - 密钥推导(AccessKeySecret + "&")与 HMAC-SHA1 的确定性
 *
 * 注:官方文档示例仅公开了 StringToSign,本文件不断言具体签名字面量
 * (避免把凭空写的期望值当成真相)。StringToSign 正确 + 密钥推导正确
 * ⇒ HMAC-SHA1 输出必然正确,故校验前两者即可。
 *
 * @author liyingjie <y@senke.com>
 */
// @ts-nocheck
/* eslint-disable */
import { describe, expect, it, vi } from 'vitest';
import { createHmac } from 'node:crypto';

vi.mock('electron', async () => await import('./__mocks__/electron.js'));

const { rfc3986, signAliyunRpc } = await import('../src/main/services/voiceService.js');

describe('RFC3986 编码', () => {
  it('空格编为 %20 而非 +', () => {
    expect(rfc3986('a b')).toBe('a%20b');
  });

  it('星号编为 %2A（encodeURIComponent 默认不编码）', () => {
    expect(rfc3986('*')).toBe('%2A');
  });

  it('波浪号保持原样（encodeURIComponent 默认编成 %7E）', () => {
    expect(rfc3986('~')).toBe('~');
  });

  it('冒号与斜杠被编码（时间戳与路径依赖此行为）', () => {
    expect(rfc3986(':')).toBe('%3A');
    expect(rfc3986('/')).toBe('%2F');
    expect(rfc3986('2016-02-23T12:46:24Z')).toBe('2016-02-23T12%3A46%3A24Z');
  });

  it('加号被编码，避免与空格语义混淆', () => {
    expect(rfc3986('+')).toBe('%2B');
  });
});

describe('StringToSign 构造（官方文档示例比对）', () => {
  // 来源：阿里云《签名机制》文档 ECS DescribeRegions 示例
  const OFFICIAL_PARAMS = {
    AccessKeyId: 'testid',
    Action: 'DescribeRegions',
    Format: 'XML',
    SignatureMethod: 'HMAC-SHA1',
    SignatureNonce: '3ee8c1b8-83d3-44af-a94f-4e0ad82fd6cf',
    SignatureVersion: '1.0',
    TimeStamp: '2016-02-23T12:46:24Z',
    Version: '2014-05-26'
  };
  const EXPECTED_STS =
    'GET&%2F&AccessKeyId%3Dtestid%26Action%3DDescribeRegions%26Format%3DXML' +
    '%26SignatureMethod%3DHMAC-SHA1%26SignatureNonce%3D3ee8c1b8-83d3-44af-a94f-4e0ad82fd6cf' +
    '%26SignatureVersion%3D1.0%26TimeStamp%3D2016-02-23T12%253A46%253A24Z%26Version%3D2014-05-26';

  it('StringToSign 与官方示例逐字节一致', () => {
    expect(signAliyunRpc(OFFICIAL_PARAMS, 'testsecret').stringToSign).toBe(EXPECTED_STS);
  });

  it('参数按 key 字典序排列（与入参顺序无关）', () => {
    const shuffled = {
      Version: '2014-05-26', AccessKeyId: 'testid', TimeStamp: '2016-02-23T12:46:24Z',
      SignatureVersion: '1.0', Format: 'XML', SignatureNonce: '3ee8c1b8-83d3-44af-a94f-4e0ad82fd6cf',
      Action: 'DescribeRegions', SignatureMethod: 'HMAC-SHA1'
    };
    expect(signAliyunRpc(shuffled, 'testsecret').stringToSign).toBe(EXPECTED_STS);
  });

  it('canonical 串本身不做二次编码（用于拼 URL query）', () => {
    const { canonical } = signAliyunRpc(OFFICIAL_PARAMS, 'testsecret');
    expect(canonical).toContain('AccessKeyId=testid');
    // 时间戳在 canonical 中是单次编码，StringToSign 里才变成 %253A
    expect(canonical).toContain('TimeStamp=2016-02-23T12%3A46%3A24Z');
  });
});

describe('签名密钥推导与确定性', () => {
  const P = { A: '1', B: '2' };

  it('HMAC 密钥为 AccessKeySecret + "&"（官方规定）', () => {
    const { stringToSign, signature } = signAliyunRpc(P, 'mysecret');
    expect(signature).toBe(createHmac('sha1', 'mysecret&').update(stringToSign).digest('base64'));
    // 不加 & 会得到不同结果 —— 锁死这个易错点
    expect(signature).not.toBe(createHmac('sha1', 'mysecret').update(stringToSign).digest('base64'));
  });

  it('相同输入产出相同签名（确定性）', () => {
    expect(signAliyunRpc(P, 's').signature).toBe(signAliyunRpc(P, 's').signature);
  });

  it('密钥不同则签名不同', () => {
    expect(signAliyunRpc(P, 's1').signature).not.toBe(signAliyunRpc(P, 's2').signature);
  });

  it('签名为合法 base64', () => {
    expect(signAliyunRpc(P, 's').signature).toMatch(/^[A-Za-z0-9+/]+=*$/);
  });

  it('参数值变化导致签名变化（防重放/篡改）', () => {
    expect(signAliyunRpc({ A: '1' }, 's').signature).not.toBe(signAliyunRpc({ A: '2' }, 's').signature);
  });
});
