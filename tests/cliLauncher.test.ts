/**
 * 跨平台 CLI 启动器测试
 *
 * 这层修复的是实测暴露的三类真实失败（Windows）：
 *   无扩展名 npm shim → ENOENT
 *   .cmd 批处理       → EINVAL（Node 禁止直接 spawn）
 *   Store 应用        → EPERM（WindowsApps reparse point）
 * 三者此前都能通过「检测」但一执行就失败，故此处逐一锁死判定。
 *
 * @author liyingjie <y@senke.com>
 */
// @ts-nocheck
/* eslint-disable */
import { describe, expect, it, vi } from 'vitest';

vi.mock('electron', async () => await import('./__mocks__/electron.js'));

const { resolveLaunch, commandNameOf, runCli } = await import('../src/main/services/cliLauncher.js');

const isWin = process.platform === 'win32';

describe('commandNameOf：取可执行命令名', () => {
  it('剥离目录与扩展名', () => {
    expect(commandNameOf('C:\\Users\\A\\AppData\\Roaming\\npm\\opencode.cmd')).toBe('opencode');
    expect(commandNameOf('C:\\tools\\codex.exe')).toBe('codex');
    expect(commandNameOf('/usr/local/bin/hermes')).toBe('hermes');
  });

  it('无扩展名的 npm shim 原样取名', () => {
    expect(commandNameOf('C:\\Users\\A\\AppData\\Roaming\\npm\\opencode')).toBe('opencode');
  });

  it('.ps1 / .bat 亦被剥离', () => {
    expect(commandNameOf('C:\\npm\\opencode.ps1')).toBe('opencode');
    expect(commandNameOf('C:\\npm\\tool.bat')).toBe('tool');
  });
});

describe('resolveLaunch：按形态决定启动方式', () => {
  it('.exe 可直接 spawn，不加包装', () => {
    const r = resolveLaunch('C:\\tools\\codex.exe', ['--version']);
    expect(r.bin).toBe('C:\\tools\\codex.exe');
    expect(r.args).toEqual(['--version']);
  });

  it.runIf(isWin)('.cmd 经 cmd.exe 拉起（Node 直接 spawn 会 EINVAL）', () => {
    const r = resolveLaunch('C:\\Users\\A\\AppData\\Roaming\\npm\\opencode.cmd', ['run', 'ping']);
    expect(r.bin).toBe('cmd.exe');
    expect(r.args).toEqual(['/d', '/s', '/c', 'opencode', 'run', 'ping']);
  });

  it.runIf(isWin)('无扩展名 npm shim 经 cmd.exe 拉起（直接 spawn 会 ENOENT）', () => {
    // 这正是用户实测报错的形态：spawn ...\npm\opencode ENOENT
    const r = resolveLaunch('C:\\Users\\A\\AppData\\Roaming\\npm\\opencode', ['run', 'x']);
    expect(r.bin).toBe('cmd.exe');
    expect(r.args.slice(0, 4)).toEqual(['/d', '/s', '/c', 'opencode']);
  });

  it.runIf(isWin)('WindowsApps 下的 Store 应用经 cmd.exe 拉起（直接 spawn 会 EPERM）', () => {
    // 用户实测报错形态：spawn ...\WindowsApps\OpenAI.Codex_...\codex.exe EPERM
    const p = 'C:\\Program Files\\WindowsApps\\OpenAI.Codex_26.721.4979.0_x64__2p2nqsd0c76g0\\app\\resources\\codex.exe';
    const r = resolveLaunch(p, ['exec', 'ping']);
    expect(r.bin).toBe('cmd.exe');
    // 用命令名而非完整路径：WindowsApps 完整路径即便经 cmd 也可能拒绝访问
    expect(r.args).toEqual(['/d', '/s', '/c', 'codex', 'exec', 'ping']);
  });

  it.runIf(isWin)('.ps1 经 cmd.exe 拉起', () => {
    expect(resolveLaunch('C:\\npm\\opencode.ps1', []).bin).toBe('cmd.exe');
  });

  it('参数原样透传，不做转义改写（避免破坏 prompt 内容）', () => {
    const prompt = '写一个函数 foo(a, b) 并说明 "为什么"';
    const r = resolveLaunch('C:\\tools\\codex.exe', ['exec', prompt]);
    expect(r.args[1]).toBe(prompt);
  });

  it.runIf(!isWin)('非 Windows 平台一律直启，不加 cmd 包装', () => {
    const r = resolveLaunch('/usr/local/bin/opencode', ['run', 'x']);
    expect(r.bin).toBe('/usr/local/bin/opencode');
    expect(r.args).toEqual(['run', 'x']);
  });
});

describe('runCli：不抛异常的一次性执行', () => {
  it('成功执行返回 ok 与 stdout', async () => {
    const r = await runCli(process.execPath, ['-e', 'process.stdout.write("hello")'], { timeoutMs: 15_000 });
    expect(r.ok).toBe(true);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('hello');
  });

  it('非零退出码如实返回，不抛异常', async () => {
    const r = await runCli(process.execPath, ['-e', 'process.exit(3)'], { timeoutMs: 15_000 });
    expect(r.ok).toBe(false);
    expect(r.code).toBe(3);
  });

  it('stderr 被单独收集', async () => {
    const r = await runCli(process.execPath, ['-e', 'process.stderr.write("oops")'], { timeoutMs: 15_000 });
    expect(r.stderr).toContain('oops');
  });

  it('不存在的可执行文件返回 error 而非抛异常', async () => {
    const r = await runCli('definitely-not-a-real-binary-xyz-123', ['--version'], { timeoutMs: 10_000 });
    expect(r.ok).toBe(false);
    expect(r.error).toBeTruthy();
  });

  it('超时被终止并如实标记（不返回 ok）', async () => {
    const r = await runCli(process.execPath, ['-e', 'setTimeout(()=>{},60000)'], { timeoutMs: 300 });
    expect(r.ok).toBe(false);
    expect(r.code).toBeNull();
    expect(r.error).toContain('超时');
  });

  it.runIf(isWin)('中文 Windows 的 GBK 错误输出被正确解码（否则错误信息全乱码）', async () => {
    // cmd.exe 在中文系统下以 GBK 写 stderr；按 UTF-8 解码会得到 '�' 乱码，
    // 既无法阅读也无法用中文特征匹配「命令未找到」。
    const r = await runCli('definitely-not-a-real-binary-xyz-123', ['--version'], { timeoutMs: 15_000 });
    expect(r.ok).toBe(false);
    expect(r.stderr).not.toContain('�');
    expect(r.error).toBeTruthy();
  });

  it('env 被透传给子进程（引擎自定义凭据依赖此行为）', async () => {
    const r = await runCli(
      process.execPath,
      ['-e', 'process.stdout.write(process.env.MY_PROBE_VAR ?? "MISSING")'],
      { timeoutMs: 15_000, env: { ...process.env, MY_PROBE_VAR: 'probe-value' } }
    );
    expect(r.stdout).toContain('probe-value');
  });
});
