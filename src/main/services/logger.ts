/**
 * 结构化日志（主进程）：替代散落的 console.*，提供级别、时间戳、模块标签。
 * 输出格式：[ISO时间] [LEVEL] [module] message {meta}
 * 后续可扩展：写入文件、远程收集、日志轮转。
 */

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const LEVEL_PRIORITY: Record<LogLevel, number> = { debug: 0, info: 1, warn: 2, error: 3 };

/** 最低输出级别（可通过 settings 动态调整） */
let minLevel: LogLevel = 'info';

export function setLogLevel(level: LogLevel) {
  minLevel = level;
}

function shouldLog(level: LogLevel): boolean {
  return LEVEL_PRIORITY[level] >= LEVEL_PRIORITY[minLevel];
}

function formatMessage(level: LogLevel, module: string, message: string, meta?: Record<string, unknown>): string {
  const ts = new Date().toISOString();
  const metaStr = meta ? ` ${JSON.stringify(meta)}` : '';
  return `[${ts}] [${level.toUpperCase()}] [${module}] ${message}${metaStr}`;
}

export interface Logger {
  debug(message: string, meta?: Record<string, unknown>): void;
  info(message: string, meta?: Record<string, unknown>): void;
  warn(message: string, meta?: Record<string, unknown>): void;
  error(message: string, meta?: Record<string, unknown>): void;
}

/** 创建模块级日志实例 */
export function createLogger(module: string): Logger {
  return {
    debug(message, meta) {
      if (shouldLog('debug')) console.debug(formatMessage('debug', module, message, meta));
    },
    info(message, meta) {
      if (shouldLog('info')) console.info(formatMessage('info', module, message, meta));
    },
    warn(message, meta) {
      if (shouldLog('warn')) console.warn(formatMessage('warn', module, message, meta));
    },
    error(message, meta) {
      if (shouldLog('error')) console.error(formatMessage('error', module, message, meta));
    }
  };
}
