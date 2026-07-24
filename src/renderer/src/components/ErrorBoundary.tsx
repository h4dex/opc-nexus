/** 全局错误边界：捕获子组件渲染异常，避免白屏；提供重试和错误详情 */
import { Component, type ErrorInfo, type ReactNode } from 'react';

interface Props { children: ReactNode; }
interface State { hasError: boolean; error: Error | null; errorInfo: ErrorInfo | null; }

export class ErrorBoundary extends Component<Props, State> {
  state: State = { hasError: false, error: null, errorInfo: null };

  static getDerivedStateFromError(error: Error): Partial<State> {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, errorInfo: ErrorInfo) {
    this.setState({ errorInfo });
    // 结构化日志输出 + 上报主进程写入审计日志
    console.error('[ErrorBoundary]', {
      message: error.message,
      stack: error.stack,
      componentStack: errorInfo.componentStack,
      timestamp: Date.now()
    });
    try {
      void window.aibox.reportError({ message: error.message, stack: error.stack, componentStack: errorInfo.componentStack ?? undefined });
    } catch { /* 上报失败不阻塞 */ }
  }

  private reset = () => {
    this.setState({ hasError: false, error: null, errorInfo: null });
  };

  render() {
    if (!this.state.hasError) return this.props.children;

    return (
      <div style={{
        display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
        height: '100vh', gap: 16, padding: 40, textAlign: 'center',
        background: 'var(--bg-1, #0f1218)', color: 'var(--text-1, #e4e4e7)'
      }}>
        <div style={{ fontSize: 48 }}>⚠️</div>
        <h2 style={{ margin: 0, fontSize: 20, fontWeight: 700 }}>页面渲染异常</h2>
        <p style={{ margin: 0, fontSize: 13, color: 'var(--text-3, #888)', maxWidth: 500, lineHeight: 1.8 }}>
          {this.state.error?.message ?? '未知错误'}
        </p>
        {this.state.errorInfo?.componentStack && (
          <pre style={{
            maxWidth: 600, maxHeight: 200, overflow: 'auto', fontSize: 11, lineHeight: 1.6,
            background: 'var(--input-bg, #1a1f2e)', padding: '12px 16px', borderRadius: 8,
            color: 'var(--text-2, #aaa)', textAlign: 'left'
          }}>
            {this.state.errorInfo.componentStack}
          </pre>
        )}
        <button onClick={this.reset} style={{
          padding: '10px 24px', borderRadius: 8, border: 'none', cursor: 'pointer',
          background: 'var(--accent, #4d6bfe)', color: '#fff', fontSize: 14, fontWeight: 600
        }}>
          重新加载页面
        </button>
      </div>
    );
  }
}
