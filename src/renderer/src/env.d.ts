/// <reference types="vite/client" />
import type { AiBoxApi } from '../../preload/index';

declare global {
  interface Window {
    aibox: AiBoxApi;
  }
}

export {};
