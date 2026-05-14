import type { LinApi } from '../preload';

declare global {
  interface Window {
    lin?: LinApi;
  }
}

export {};
