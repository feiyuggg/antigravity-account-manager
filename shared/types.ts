export type AuthMode = 'terminal-login' | 'oauth-personal' | 'oauth-business';

export type IsolationMode = 'isolated' | 'system';

export interface AccountProfile {
  id: string;
  nickname: string;
  emailHint?: string;
  note?: string;
  color: string;
  isolationMode: IsolationMode;
  preferredAuthMode: AuthMode;
  createdAt: string;
  lastVerifiedAt?: string;
  lastSwitchedAt?: string;
}

export interface ProfileSessionStatus {
  accountId: string;
  authenticated: boolean;
  detectedEmail?: string;
  supportsLogout: boolean;
  checkedAt: string;
  profileHome: string;
  envPreview: Record<string, string>;
  error?: string;
}

export interface AntigravityAppStatus {
  appPath: string;
  exists: boolean;
  running: boolean;
  pids: number[];
  checkedAt: string;
}

export interface RuntimeInfo {
  agyPath: string | null;
  agyVersion: string | null;
  acpServerVersion: string | null;
  realHome: string;
  profilesRootDir: string;
  checkedAt: string;
  error?: string;
}

export interface AuditEntry {
  id: string;
  timestamp: string;
  source: 'ACP_RPC' | 'ACP_TERMINAL' | 'ENV_ISOLATION' | 'APP_LIFECYCLE';
  operation: string;
  status: 'ok' | 'error' | 'running';
  durationMs?: number;
  detail?: string;
}

export interface PostRestartCommandItem {
  id: string;
  name: string;
  command: string;
  enabled: boolean;
}

export interface PostRestartHooksResult {
  total: number;
  succeeded: number;
  failed: Array<{ name: string; detail: string }>;
}

export type UpdatePhase =
  | 'idle'
  | 'checking'
  | 'up_to_date'
  | 'available'
  | 'downloading'
  | 'verifying'
  | 'installing'
  | 'error';

export interface UpdateState {
  phase: UpdatePhase;
  currentVersion: string;
  latestVersion?: string;
  releaseUrl?: string;
  releaseNotes?: string;
  assetName?: string;
  progressPercent?: number;
  message: string;
  checkedAt?: string;
  error?: string;
}

export interface AppSettings {
  agyPathOverride: string;
  antigravityAppPath: string;
  profilesRootDir: string;
  defaultAuthMode: AuthMode;
  extraLaunchArgs: string;
  postRestartCommand: string;
  postRestartCommands: PostRestartCommandItem[];
  shareConversationsAndProjects: boolean;
  shareGlobalCustomizations: boolean;
  symlinkShellConfig: boolean;
  showTrayAccount: boolean;
  theme: 'system' | 'dark' | 'light';
}

export type WorkflowKind = 'idle' | 'switch' | 'login' | 'quick_add' | 'logout';

export type WorkflowPhase =
  | 'idle'
  | 'preparing_env'
  | 'probing'
  | 'awaiting_auth'
  | 'quitting_app'
  | 'launching_app'
  | 'logging_out'
  | 'done'
  | 'error'
  | 'cancelled';

export interface WorkflowState {
  kind: WorkflowKind;
  phase: WorkflowPhase;
  targetAccountId?: string;
  authMode?: AuthMode;
  restartAfterLogin?: boolean;
  autoCreatedAccount?: boolean;
  message: string;
  terminalOutput?: string;
  detectedUrl?: string;
  error?: string;
}

export interface AppStateSnapshot {
  accounts: AccountProfile[];
  activeAccountId: string | null;
  settings: AppSettings;
  runtimeInfo: RuntimeInfo | null;
  appStatus: AntigravityAppStatus | null;
  sessionStatuses: Record<string, ProfileSessionStatus>;
  auditLog: AuditEntry[];
  workflowState: WorkflowState;
  updateState: UpdateState;
  isRefreshing: boolean;
}

export interface AccountSaveInput {
  id?: string;
  nickname: string;
  emailHint?: string;
  note?: string;
  color: string;
  isolationMode: IsolationMode;
  preferredAuthMode: AuthMode;
}

export interface LoginStartInput {
  accountId: string;
  authMode: AuthMode;
  restartAfterLogin?: boolean;
}

export interface SwitchStartInput {
  accountId: string;
  authModeOverride?: AuthMode;
}
