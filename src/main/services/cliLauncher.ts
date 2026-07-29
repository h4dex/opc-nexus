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
 * 实测唯一可行路径是经 `cmd.exe /d /s /c <命令>` 拉起。
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

const isWin = process.platform === 'win32';

/**
 * cmd.exe / shell 在命令不存在时的输出特征。
 * 经 cmd 包装后 spawn 不再报 ENOENT，只能从 stderr 识别。
 * 中文 Windows 的 cmd 以 GBK 输出，故同时匹配解码后文本与 UTF-8 误读产生的乱码特征。
 */
const NOT_FOUND_PATTERN = /不是内部或外部命令|is not recognized as|command not found|无法将.*识别为/i;

/**
 * 解码子进程输出。
 * 中文 Windows 的 cmd.exe 以 GBK(CP936) 写 stderr，直接按 UTF-8 解码会得到乱码，
 * 导致错误信息无法阅读、也无法用中文特征匹配。这里先试 UTF-8，
 * 若出现替换字符（U+FFFD）则回退 GBK。
 */
function decodeOutput(buf: Buffer): string {
  const utf8 = buf.toString('utf8');
  if (!utf8.includes('�')) return utf8;
  try {
    // Node 内置 ICU 支持 gbk；不可用时退回原始 UTF-8 结果
    return new TextDecoder('gbk').decode(buf);
  } catch {
    return utf8;
  }
}

/** 需要经 cmd.exe 间接拉起的可执行形态 */
function needsCmdShim(binPath: string): boolean {
  if (!isWin) return false;
  // .cmd / .bat：Node 禁止直接 spawn
  if (/\.(cmd|bat)$/i.test(binPath)) return true;
  // .ps1：需 powershell 解释，统一交给 cmd.exe 走 PATH
  if (/\.ps1$/i.test(binPath)) return true;
  // Store 应用（WindowsApps 下的 reparse point）：直接 spawn 得 EPERM
  if (/[\\/]WindowsApps[\\/]/i.test(binPath)) return true;
  // 无扩展名：npm shim（Windows 不视其为可执行文件 → ENOENT）
  if (!/\.[a-z0-9]+$/i.test(binPath)) return true;
  return false;
}

/**
 * 把「命令 + 参数」翻译成当前平台真正可 spawn 的形式。
 * 需要 shim 时改用 `cmd.exe /d /s /c`，并把原命令名（而非完整路径）交给 cmd 走 PATH 解析
 * —— WindowsApps 的完整路径即便经 cmd 也可能拒绝访问，用命令名更稳。
 */
export function resolveLaunch(binPath: string, args: string[]): { bin: string; args: string[] } {
  if (!needsCmdShim(binPath)) return { bin: binPath, args };
  const name = commandNameOf(binPath);
  return { bin: 'cmd.exe', args: ['/d', '/s', '/c', name, ...args] };
}

/** 从完整路径取出可执行命令名（去目录、去扩展名），供 cmd.exe 按 PATH 解析 */
export function commandNameOf(binPath: string): string {
  const base = binPath.split(/[\\/]/).pop() ?? binPath;
  return base.replace(/\.(exe|cmd|bat|ps1)$/i, '');
}

/** 按平台正确启动 CLI；其余 spawn 选项原样透传（cwd / env / windowsHide 等） */
export function spawnCli(binPath: string, args: string[], opts: SpawnOptions = {}): ChildProcess {
  const { bin, args: finalArgs } = resolveLaunch(binPath, args);
  return spawn(bin, finalArgs, { shell: false, windowsHide: true, ...opts });
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
    const done = (r: { ok: boolean; code: number | null; stdout: string; stderr: string; error?: string }) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(r);
    };
    const timer = setTimeout(() => {
      try { child.kill('SIGKILL'); } catch { /* 已退出 */ }
      done({ ok: false, code: null, stdout, stderr, error: `执行超时（${Math.round(timeoutMs / 1000)} 秒）` });
    }, timeoutMs);

    // 按块缓存后统一解码：避免多字节字符被 chunk 边界切断而解码失败
    const outChunks: Buffer[] = [];
    const errChunks: Buffer[] = [];
    child.stdout?.on('data', (c: Buffer) => { outChunks.push(c); });
    child.stderr?.on('data', (c: Buffer) => { errChunks.push(c); });
    child.on('error', (err) => done({
      ok: false, code: null,
      stdout: decodeOutput(Buffer.concat(outChunks)),
      stderr: decodeOutput(Buffer.concat(errChunks)),
      error: err.message
    }));
    child.on('close', (code) => {
      stdout = decodeOutput(Buffer.concat(outChunks));
      stderr = decodeOutput(Buffer.concat(errChunks));
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
