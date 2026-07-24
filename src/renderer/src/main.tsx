import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { ErrorBoundary } from './components/ErrorBoundary';
import { toast } from './components/Toast';
import './styles/global.css';

// 全局捕获未处理的 Promise 拒绝（主要为 IPC 调用失败），避免静默失败，给用户反馈
window.addEventListener('unhandledrejection', (e) => {
  const msg = e.reason instanceof Error ? e.reason.message : String(e.reason ?? '');
  if (msg) toast.err(`操作失败：${msg.slice(0, 120)}`);
});

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  </StrictMode>
);
