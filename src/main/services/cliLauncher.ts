/**
 * 跨平台 CLI 启动器
 *
 * 【为什么需要这层】
 * npm 全局安装的 CLI 在 Windows 上会生成三个入口：
 *   opencode        无扩展名 shell 脚本（供 Git Bash / WSL）
 *   opencode.cmd    批处理封装（供 cmd/PowerShell）
 *   opencode.ps1    PowerShell 封装
 * 而 Node 的 spawn(shell:false) 对这两者都无法直接执行：
 *   - 无扩展名 shim → ENOENT（Windows 不认识它是可执行文件）
 *   - .cmd          → EINVAL（Node 出于安全禁止直接 spawn 批处理）
 * 这些入口通过配套 PowerShell shim 的 `-File` 模式拉起。不能把用户参数
 * 拼入 `cmd.exe /c`，否则 `&`、引号等元字符会变成额外命令。
 *
 * 另有一类：Microsoft Store 分发的应用（WindowsApps 下的 reparse point），
 * 直接 spawn 会得到 EPERM，同样需要经 cmd.exe 走 PATH 解析。
 *
 * 本模块把「怎么正确启动一个 CLI」收敛到一处，检测、版本探测、鉴权探测、
 * 任务执行共用同一策略，避免各处各写一套而漏掉某种形态。
 *
 * @author liyingjie <y@senke.com>
 */
import { spawn, type ChildProcess, type SpawnOptions } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { delimiter, dirname, extname, isAbsolute, join, relative, resolve } from 'node:path';
import { appendProcessOutput, createProcessOutputBuffer, finishProcessOutput } from './textEncoding.js';

const isWin = process.platform === 'win32';
const PROCESS_TREE_KILL_TIMEOUT_MS = 5_000;

/**
 * CLI shim 在命令不存在时的输出特征。
 */
const NOT_FOUND_PATTERN = /不是内部或外部命令|is not recognized as|command not found|无法将.*识别为/i;

/**
 * 解码子进程输出。
 * 中文 Windows 的 cmd.exe 以 GBK(CP936) 写 stderr，直接按 UTF-8 解码会得到乱码，
 * 导致错误信息无法阅读、也无法用中文特征匹配。这里先试 UTF-8，
 * 若出现替换字符（U+FFFD）则回退 GBK。
 */
function pathEntries(env: NodeJS.ProcessEnv): string[] {
  return (env.PATH ?? env.Path ?? env.path ?? '')
    .split(delimiter)
    .map((entry) => entry.trim().replace(/^"|"$/g, ''))
    .filter(Boolean);
}

function companionPowerShellShim(binPath: string, env: NodeJS.ProcessEnv): string | null {
  const ext = extname(binPath).toLowerCase();
  const base = ['.cmd', '.bat', '.ps1'].includes(ext) ? binPath.slice(0, -ext.length) : binPath;
  if (isAbsolute(binPath) || /[\\/]/.test(binPath)) {
    const candidate = `${base}.ps1`;
    return existsSync(candidate) ? candidate : null;
  }
  const name = commandNameOf(binPath);
  for (const entry of pathEntries(env)) {
    const candidate = join(entry, `${name}.ps1`);
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

function powerShellLaunch(scriptPath: string, args: string[]): { bin: string; args: string[] } {
  return {
    bin: 'powershell.exe',
    args: ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', scriptPath, ...args]
  };
}

function insideDirectory(base: string, target: string): boolean {
  const rel = relative(base, target);
  return rel.length > 0 && !rel.startsWith('..') && !isAbsolute(rel);
}

/** Resolve the fixed target from an npm-generated PowerShell shim.
 *
 * npm shims pipe `$input` into the real CLI whenever PowerShell sees redirected
 * stdin. A desktop child process has redirected stdin even when no payload is
 * intended, so Codex `exec` waits forever for "additional input". Standard
 * npm shims contain only a basedir-scoped executable or a Node script; launch
 * that verified target directly and leave custom PowerShell scripts untouched.
 */
function directNpmShimLaunch(scriptPath: string, args: string[]): { bin: string; args: string[] } | null {
  let source = '';
  try {
    source = readFileSync(scriptPath, 'utf8');
  } catch {
    return null;
  }
  if (source.length > 64 * 1024
    || !source.includes('$basedir=Split-Path $MyInvocation.MyCommand.Definition -Parent')
    || !source.includes('$MyInvocation.ExpectingInput')) return null;

  const base = dirname(resolve(scriptPath));
  const lines = source.split(/\r?\n/).filter((line) => !line.includes('$input |'));
  for (const line of lines) {
    const match = line.match(/^\s*&\s+"([^"]+)"(?:\s+"([^"]+)")?\s+\$args\s*$/);
    if (!match) continue;
    const command = match[1];
    const target = match[2];

    if ((command === '$basedir/node$exe' || command === 'node$exe') && target?.startsWith('$basedir/')) {
      const script = resolve(base, target.slice('$basedir/'.length));
      if (!insideDirectory(base, script) || !existsSync(script)) continue;
      const bundledNode = join(base, 'node.exe');
      return { bin: existsSync(bundledNode) ? bundledNode : 'node.exe', args: [script, ...args] };
    }

    if (command.startsWith('$basedir/')) {
      const executable = resolve(base, command.slice('$basedir/'.length));
      if (!insideDirectory(base, executable) || !existsSync(executable)
        || !['.exe', '.com'].includes(extname(executable).toLowerCase())) continue;
      return { bin: executable, args };
    }
  }
  return null;
}

/**
 * 把「命令 + 参数」翻译成当前平台真正可 spawn 的形式。
 * Windows npm shim 通过 PowerShell `-File` 执行，参数保持独立 argv，绝不进入
 * shell 命令字符串。没有安全伴生入口的 batch 文件直接拒绝执行。
 */
export function resolveLaunch(binPath: string, args: string[], env: NodeJS.ProcessEnv = process.env): { bin: string; args: string[] } {
  // Packaged Codex/Pi runtimes expose a JavaScript entry point rather than a
  // PATH shim. Electron's executable can run that entry point when
  // ELECTRON_RUN_AS_NODE is set; plain Node processes ignore the variable.
  const scriptExt = extname(binPath).toLowerCase();
  if (isAbsolute(binPath) && ['.js', '.mjs', '.cjs'].includes(scriptExt) && existsSync(binPath)) {
    return { bin: process.execPath, args: [binPath, ...args] };
  }
  if (!isWin) return { bin: binPath, args };
  if (/[\\/]WindowsApps[\\/]/i.test(binPath)) {
    return { bin: `${commandNameOf(binPath)}.exe`, args };
  }
  const ext = extname(binPath).toLowerCase();
  if (ext === '.ps1') return directNpmShimLaunch(binPath, args) ?? powerShellLaunch(binPath, args);
  if (ext === '.cmd' || ext === '.bat' || ext === '') {
    const shim = companionPowerShellShim(binPath, env);
    if (shim) return directNpmShimLaunch(shim, args) ?? powerShellLaunch(shim, args);
    const executable = ext === '' ? `${binPath}.exe` : '';
    if (executable && (!/[\\/]/.test(binPath) || existsSync(executable))) {
      return { bin: executable, args };
    }
    throw new Error(`Unsafe Windows command shim has no PowerShell companion: ${binPath}`);
  }
  return { bin: binPath, args };
}

/** 从完整路径取出可执行命令名（去目录、去扩展名），供 cmd.exe 按 PATH 解析 */
export function commandNameOf(binPath: string): string {
  const base = binPath.split(/[\\/]/).pop() ?? binPath;
  return base.replace(/\.(exe|cmd|bat|ps1)$/i, '');
}

/** 按平台正确启动 CLI；其余 spawn 选项原样透传（cwd / env / windowsHide 等） */
export function spawnCli(binPath: string, args: string[], opts: SpawnOptions = {}): ChildProcess {
  const { bin, args: finalArgs } = resolveLaunch(binPath, args, opts.env as NodeJS.ProcessEnv | undefined);
  const scriptLaunch = bin === process.execPath
    && finalArgs.length > 0
    && typeof finalArgs[0] === 'string'
    && ['.js', '.mjs', '.cjs'].includes(extname(finalArgs[0]).toLowerCase());
  const env = scriptLaunch
    ? { ...(opts.env ?? process.env), ELECTRON_RUN_AS_NODE: '1' }
    : opts.env;
  // npm-generated PowerShell shims inspect stdin and pipe `$input` into Node
  // when it is open. A never-written parent pipe therefore blocks the CLI
  // before it can even process `--version`. Interactive protocols explicitly
  // override this default with stdio: ['pipe', 'pipe', 'pipe'].
  return spawn(bin, finalArgs, {
    ...opts,
    shell: opts.shell ?? false,
    windowsHide: opts.windowsHide ?? true,
    stdio: opts.stdio ?? ['ignore', 'pipe', 'pipe'],
    ...(env ? { env } : {})
  });
}

/**
 * 终止一次 CLI 调用。
 * Windows 的 npm/.cmd 入口会形成 cmd.exe -> CLI -> runtime 的进程树，单独
 * child.kill() 只会结束最外层 cmd.exe，实际 CLI 会继续占用设备锁和应用退出流程。
 */
export async function terminateCliProcess(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;

  if (!isWin || !child.pid) {
    try { child.kill('SIGKILL'); } catch { /* 已退出 */ }
    return;
  }

  await new Promise<void>((resolve) => {
    let settled = false;
    const done = () => {
      if (settled) return;
      settled = true;
      clearTimeout(fallbackTimer);
      resolve();
    };
    const fallbackTimer = setTimeout(() => {
      try { child.kill('SIGKILL'); } catch { /* 已退出 */ }
      done();
    }, PROCESS_TREE_KILL_TIMEOUT_MS);

    try {
      const killer = spawn('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], {
        shell: false,
        windowsHide: true,
        stdio: 'ignore'
      });
      killer.once('error', () => {
        try { child.kill('SIGKILL'); } catch { /* 已退出 */ }
        done();
      });
      killer.once('close', done);
    } catch {
      try { child.kill('SIGKILL'); } catch { /* 已退出 */ }
      done();
    }
  });
}

/**
 * 一次性执行并收集输出（用于 --version / 最小任务探测）。
 * 不抛异常：启动失败也返回结构化结果，调用方据此判定，避免异常穿透到启动路径。
 */
export function runCli(
  binPath: string,
  args: string[],
  opts: { timeoutMs?: number; cwd?: string; env?: NodeJS.ProcessEnv } = {}
): Promise<{ ok: boolean; code: number | null; stdout: string; stderr: string; error?: string }> {
  const timeoutMs = opts.timeoutMs ?? 10_000;
  return new Promise((resolve) => {
    let child: ChildProcess;
    try {
      child = spawnCli(binPath, args, { cwd: opts.cwd, env: opts.env });
    } catch (err) {
      return resolve({ ok: false, code: null, stdout: '', stderr: '', error: err instanceof Error ? err.message : String(err) });
    }
    let stdout = '';
    let stderr = '';
    let settled = false;
    let timedOut = false;
    const done = (r: { ok: boolean; code: number | null; stdout: string; stderr: string; error?: string }) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(r);
    };
    const timer = setTimeout(async () => {
      timedOut = true;
      await terminateCliProcess(child);
      stdout = finishProcessOutput(outBuffer);
      stderr = finishProcessOutput(errBuffer);
      done({ ok: false, code: null, stdout, stderr, error: `执行超时（${Math.round(timeoutMs / 1000)} 秒）` });
    }, timeoutMs);

    // 按块缓存后统一解码：避免多字节字符被 chunk 边界切断而解码失败
    const outBuffer = createProcessOutputBuffer();
    const errBuffer = createProcessOutputBuffer();
    child.stdout?.on('data', (c: Buffer) => appendProcessOutput(outBuffer, c));
    child.stderr?.on('data', (c: Buffer) => appendProcessOutput(errBuffer, c));
    child.on('error', (err) => {
      if (timedOut) return;
      done({
        ok: false, code: null,
        stdout: finishProcessOutput(outBuffer),
        stderr: finishProcessOutput(errBuffer),
        error: err.message
      });
    });
    child.on('close', (code) => {
      if (timedOut) return;
      stdout = finishProcessOutput(outBuffer);
      stderr = finishProcessOutput(errBuffer);
      // 经 cmd.exe 包装后，命令不存在不会触发 'error'，而是 cmd 自己以非 0 退出并在
      // stderr 写 "不是内部或外部命令" / "is not recognized"。若不识别这种情况，
      // 「进程起不来」会被误判成「起来了但执行失败」，四级探活的 launchable 就失去意义。
      const notFound = code !== 0 && NOT_FOUND_PATTERN.test(stderr);
      done({
        ok: code === 0,
        code,
        stdout,
        stderr,
        ...(notFound ? { error: `命令未找到：${stderr.trim().split(/\r?\n/)[0]?.slice(0, 120)}` } : {})
      });
    });
  });
}
