export const env = {
  language: "en",
};

export const window = {
  showWarningMessage: () => undefined,
  showErrorMessage: () => undefined,
  showInformationMessage: () => undefined,
  createOutputChannel: (_name: string, _options?: Record<string, unknown>) => {
    // Plain OutputChannel used by utils/logger: appendLine is never
    // filtered and clear() really empties the rendered buffer.
    const rendered: string[] = [];
    const channel = {
      appendLine: (line: string) => {
        rendered.push(line);
      },
      clear: () => {
        rendered.length = 0;
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

export const QuickInputButtons = {
  Back: Symbol("Back"),
};

export class ThemeIcon {
  constructor(public id: string) {}
}

export const Uri = {
  file: (p: string) => ({ fsPath: p }),
};

export const CancellationError = class extends Error {};

export default {
  env,
  window,
  workspace,
  ProgressLocation,
  QuickInputButtons,
  ThemeIcon,
  Uri,
  CancellationError,
};
