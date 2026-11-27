import { contextBridge, ipcRenderer } from 'electron';
import type {
  AccountSaveInput,
  AppSettings,
  AppStateSnapshot,
  LoginStartInput,
  PostRestartHooksResult,
  SwitchStartInput,
} from '../shared/types';

export interface AccountManagerApi {
  getState: () => Promise<AppStateSnapshot>;
  refreshAll: () => Promise<AppStateSnapshot>;
  probeAccount: (accountId: string) => Promise<AppStateSnapshot>;
  saveAccount: (input: AccountSaveInput) => Promise<AppStateSnapshot & { savedAccountId?: string }>;
  quickAddAccount: (options?: { restartAfterLogin?: boolean }) => Promise<void>;
  deleteAccount: (id: string, removeProfileDir?: boolean) => Promise<AppStateSnapshot>;
  startLogin: (input: LoginStartInput) => Promise<void>;
  startSwitchAndRestart: (input: SwitchStartInput) => Promise<void>;
  restartActiveApp: () => Promise<void>;
  runPostRestartHooks: () => Promise<{ snapshot: AppStateSnapshot; result: PostRestartHooksResult }>;
  submitAuthCode: (code: string) => Promise<void>;
  cancelWorkflow: () => Promise<void>;
  logoutAccount: (accountId: string) => Promise<AppStateSnapshot>;
  updateSettings: (partial: Partial<AppSettings>) => Promise<AppStateSnapshot>;
  openProfileInFinder: (accountId?: string) => Promise<void>;
  clearAuditLog: () => Promise<AppStateSnapshot>;
  openExternalUrl: (url: string) => Promise<void>;
  copyText: (text: string) => Promise<void>;
  onStateChanged: (callback: (snapshot: AppStateSnapshot) => void) => () => void;
}

const api: AccountManagerApi = {
  getState: () => ipcRenderer.invoke('state:get'),
  refreshAll: () => ipcRenderer.invoke('acp:refreshAll'),
  probeAccount: (accountId) => ipcRenderer.invoke('acp:probeAccount', accountId),
  saveAccount: (input) => ipcRenderer.invoke('account:save', input),
  quickAddAccount: (options) => ipcRenderer.invoke('account:quickAdd', options),
  deleteAccount: (id, removeProfileDir) =>
    ipcRenderer.invoke('account:delete', id, removeProfileDir),
  startLogin: (input) => ipcRenderer.invoke('acp:loginStart', input),
  startSwitchAndRestart: (input) => ipcRenderer.invoke('app:switchAndRestart', input),
  restartActiveApp: () => ipcRenderer.invoke('app:restartActive'),
  runPostRestartHooks: () => ipcRenderer.invoke('app:runPostRestartHooks'),
  submitAuthCode: (code) => ipcRenderer.invoke('acp:submitCode', code),
  cancelWorkflow: () => ipcRenderer.invoke('workflow:cancel'),
  logoutAccount: (accountId) => ipcRenderer.invoke('acp:logoutAccount', accountId),
  updateSettings: (partial) => ipcRenderer.invoke('settings:update', partial),
  openProfileInFinder: (accountId) => ipcRenderer.invoke('shell:openProfileFolder', accountId),
  clearAuditLog: () => ipcRenderer.invoke('audit:clear'),
  openExternalUrl: (url) => ipcRenderer.invoke('shell:openExternal', url),
  copyText: (text) => ipcRenderer.invoke('clipboard:writeText', text),
  onStateChanged: (callback) => {
    const listener = (_event: Electron.IpcRendererEvent, snapshot: AppStateSnapshot) => {
      callback(snapshot);
    };
    ipcRenderer.on('state:updated', listener);
    return () => {
      ipcRenderer.removeListener('state:updated', listener);
    };
  },
};

contextBridge.exposeInMainWorld('accountManager', api);
