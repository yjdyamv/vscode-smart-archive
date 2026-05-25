export const env = { language: "en" };

export const window = {
  showWarningMessage: () => undefined,
  showErrorMessage: () => undefined,
  showInformationMessage: () => undefined,
  createOutputChannel: (_name: string, _options?: Record<string, unknown>) => ({
    appendLine: () => {},
    info: () => {},
    warn: () => {},
    error: () => {},
    show: () => {},
    dispose: () => {},
  }),
};

export const workspace = {
  getConfiguration: () => ({
    get: () => "auto",
  }),
};

export const ProgressLocation = {
  Notification: 1,
};

export const Uri = {
  file: (p: string) => ({ fsPath: p }),
};

export const CancellationError = class extends Error {};

export default {
  env,
  window,
  workspace,
  ProgressLocation,
  Uri,
  CancellationError,
};
