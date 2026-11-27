/// <reference types="vite/client" />

import type { AccountManagerApi } from '../electron/preload';

declare global {
  interface Window {
    accountManager: AccountManagerApi;
  }
}
