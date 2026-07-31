export const env = { language: "en" };

export const window = {
  showWarningMessage: () => undefined,
  showErrorMessage: () => undefined,
  showInformationMessage: () => undefined,
  createOutputChannel: (_name: string, _options?: Record<string, unknown>) => {
    // Mimic the real LogOutputChannel: level methods are filtered by the
    // panel logLevel (default Info), appendLine is not filtered.
    const listeners: Array<(lvl: number) => void> = [];
    let logLevel = LogLevel.Info;
    const channel = {
      get logLevel() {
        return logLevel;
      },
      set logLevel(lvl: number) {
        logLevel = lvl;
        for (const cb of listeners) cb(lvl);
      },
      appendLine: () => {},
      info: () => {},
      warn: () => {},
      error: () => {},
      debug: () => {},
      onDidChangeLogLevel: (cb: (lvl: number) => void) => {
        listeners.push(cb);
        return { dispose: () => {} };
      },
      show: () => {},
      dispose: () => {},
    };
    return channel;
  },
};

export const workspace = {
  getConfiguration: () => ({
    get: () => "auto",
    inspect: () => undefined,
  }),
};

export const ProgressLocation = {
  Notification: 1,
};

export const Uri = {
  file: (p: string) => ({ fsPath: p }),
};

export const CancellationError = class extends Error {};

export const LogLevel = {
  Off: 0,
  Trace: 1,
  Debug: 2,
  Info: 3,
  Warning: 4,
  Error: 5,
};

export default {
  env,
  window,
  workspace,
  ProgressLocation,
  Uri,
  CancellationError,
  LogLevel,
};
