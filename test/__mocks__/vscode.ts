/**
 * vscode test double — Smart Archive VSCode Extension
 *
 * A deep adapter at the vscode seam. Small test-visible interface:
 * keyed configuration, recorded dialogs, scriptable pickers/inputs, and
 * a per-test reset. Production code (which imports * as vscode) crosses
 * this seam exactly as it crosses real vscode; tests drive it through
 * the helpers below instead of mutating globals at runtime.
 *
 * Test-facing interface (import * as vscode from "vscode" in tests):
 *   __resetVscodeMock()  — clear config, dialogs, pickers, channels
 *   __setConfig(section, key, value) / __getConfig(section, key, def)
 *   __dialogs()          — { kind, message, items }[] recorded calls
 *   __quickPicks() / __inputBoxes() — live scriptable widgets
 *   __channels()         — created output channels (with lines)
 */

// ── State (reset per test via __resetVscodeMock) ────────────────────

interface DialogRecord {
  kind: "warning" | "error" | "information";
  message: string;
  items: readonly unknown[];
}

const state = {
  language: "en",
  config: new Map<string, unknown>(),
  dialogs: [] as DialogRecord[],
  quickPicks: [] as FakeQuickPick[],
  inputBoxes: [] as FakeInputBox[],
  channels: [] as { name: string; lines: string[] }[],
  workspaceFs: undefined as unknown,
  showSaveDialogResult: undefined as unknown,
  showOpenDialogResult: undefined as unknown,
};

export function __resetVscodeMock(): void {
  state.config.clear();
  state.dialogs.length = 0;
  state.quickPicks.length = 0;
  state.inputBoxes.length = 0;
  state.channels.length = 0;
  state.workspaceFs = undefined;
  state.showSaveDialogResult = undefined;
  state.showOpenDialogResult = undefined;
  state.language = "en";
}

export function __setConfig(section: string, key: string, value: unknown): void {
  state.config.set(`${section}.${key}`, value);
}

export function __getConfig(section: string, key: string, def?: unknown): unknown {
  const v = state.config.get(`${section}.${key}`);
  return v === undefined ? def : v;
}

export function __dialogs(): readonly DialogRecord[] {
  return state.dialogs;
}

export function __quickPicks(): readonly FakeQuickPick[] {
  return state.quickPicks;
}

export function __inputBoxes(): readonly FakeInputBox[] {
  return state.inputBoxes;
}

export function __channels(): readonly { name: string; lines: string[] }[] {
  return state.channels;
}

/** Script the next save/open dialog result (or provide a default). */
export function __setSaveDialogResult(uri: unknown): void {
  state.showSaveDialogResult = uri;
}

export function __setOpenDialogResult(uris: unknown[]): void {
  state.showOpenDialogResult = uris;
}

export function __setWorkspaceFs(fs: unknown): void {
  state.workspaceFs = fs;
}

// ── Scriptable widgets ──────────────────────────────────────────────

type Listener = (e: unknown) => void;

class FakeQuickPick {
  items: { label: string; value?: unknown }[] = [];
  selectedItems: { label: string; value?: unknown }[] = [];
  activeItems: { label: string; value?: unknown }[] = [];
  value = "";
  placeholder = "";
  buttons: unknown[] = [];
  readonly = false;
  private listeners: Record<string, Listener[]> = {};
  private hidden = false;

  private fire(event: string, arg: unknown): void {
    for (const l of this.listeners[event] ?? []) l(arg);
  }

  onDidAccept(cb: () => void): { dispose: () => void } {
    (this.listeners["accept"] ??= []).push(cb as Listener);
    return { dispose: () => {} };
  }
  onDidHide(cb: () => void): { dispose: () => void } {
    (this.listeners["hide"] ??= []).push(cb as Listener);
    return { dispose: () => {} };
  }
  onDidTriggerButton(cb: (b: unknown) => void): { dispose: () => void } {
    (this.listeners["button"] ??= []).push(cb as Listener);
    return { dispose: () => {} };
  }
  onDidChangeSelection(cb: () => void): { dispose: () => void } {
    (this.listeners["selection"] ??= []).push(cb as Listener);
    return { dispose: () => {} };
  }
  onDidChangeValue(cb: () => void): { dispose: () => void } {
    (this.listeners["value"] ??= []).push(cb as Listener);
    return { dispose: () => {} };
  }
  show(): void {
    this.hidden = false;
  }
  hide(): void {
    this.hidden = true;
    this.fire("hide", undefined);
  }
  dispose(): void {}

  // ── Test driver ──

  accept(item?: { label: string; value?: unknown }): void {
    if (item) this.selectedItems = [item];
    this.fire("selection", undefined);
    this.fire("accept", undefined);
  }
  triggerButton(button: unknown): void {
    this.fire("button", button);
  }
  get hiddenState(): boolean {
    return this.hidden;
  }
}

class FakeInputBox {
  value = "";
  placeholder = "";
  password = false;
  buttons: unknown[] = [];
  private listeners: Record<string, Listener[]> = {};
  private hidden = false;

  private fire(event: string, arg: unknown): void {
    for (const l of this.listeners[event] ?? []) l(arg);
  }

  onDidAccept(cb: () => void): { dispose: () => void } {
    (this.listeners["accept"] ??= []).push(cb as Listener);
    return { dispose: () => {} };
  }
  onDidHide(cb: () => void): { dispose: () => void } {
    (this.listeners["hide"] ??= []).push(cb as Listener);
    return { dispose: () => {} };
  }
  onDidTriggerButton(cb: (b: unknown) => void): { dispose: () => void } {
    (this.listeners["button"] ??= []).push(cb as Listener);
    return { dispose: () => {} };
  }
  onDidChangeValue(cb: () => void): { dispose: () => void } {
    (this.listeners["value"] ??= []).push(cb as Listener);
    return { dispose: () => {} };
  }
  show(): void {
    this.hidden = false;
  }
  hide(): void {
    this.hidden = true;
    this.fire("hide", undefined);
  }
  dispose(): void {}

  // ── Test driver ──

  accept(value?: string): void {
    if (value !== undefined) this.value = value;
    this.fire("accept", undefined);
  }
  triggerButton(button: unknown): void {
    this.fire("button", button);
  }
  get hiddenState(): boolean {
    return this.hidden;
  }
}

// ── vscode surface ──────────────────────────────────────────────────

export const env = {
  get language(): string {
    return state.language;
  },
};

export const window = {
  showWarningMessage: (message: string, ...items: unknown[]) => {
    state.dialogs.push({ kind: "warning", message, items });
    return Promise.resolve(undefined);
  },
  showErrorMessage: (message: string, ...items: unknown[]) => {
    state.dialogs.push({ kind: "error", message, items });
    return Promise.resolve(undefined);
  },
  showInformationMessage: (message: string, ...items: unknown[]) => {
    state.dialogs.push({ kind: "information", message, items });
    return Promise.resolve(undefined);
  },
  showQuickPick: <T extends { label: string }>(items: readonly T[], _options?: unknown): Promise<T | undefined> => {
    // Recorded like dialogs; tests spy on it to script the selection.
    state.quickPicks.push({ items, accepted: undefined } as never);
    return Promise.resolve(undefined);
  },
  showSaveDialog: async () => state.showSaveDialogResult,
  showOpenDialog: async () => state.showOpenDialogResult,
  createOutputChannel: (name: string) => {
    const channel = { name, lines: [] as string[] };
    state.channels.push(channel);
    return {
      appendLine: (line: string) => {
        channel.lines.push(line);
      },
      clear: () => {
        channel.lines.length = 0;
      },
      show: () => {},
      dispose: () => {},
    };
  },
  createQuickPick: () => {
    const qp = new FakeQuickPick();
    state.quickPicks.push(qp);
    return qp;
  },
  createInputBox: () => {
    const ib = new FakeInputBox();
    state.inputBoxes.push(ib);
    return ib;
  },
  withProgress: async <T>(
    _options: unknown,
    task: (progress: { report: (p: unknown) => void }, token: { isCancellationRequested: boolean }) => T | Promise<T>,
  ): Promise<T> => {
    return task({ report: () => {} }, { isCancellationRequested: false });
  },
};

export const workspace = {
  getConfiguration: (section?: string) => {
    const prefix = section ? `${section}.` : "";
    return {
      get: <T>(key: string, def?: T): T | undefined => {
        const v = state.config.get(`${prefix}${key}`);
        return v === undefined ? def : (v as T);
      },
      inspect: () => undefined,
      update: async () => {},
    };
  },
  get fs(): unknown {
    return state.workspaceFs;
  },
  set fs(v: unknown) {
    state.workspaceFs = v;
  },
  onDidCloseTextDocument: () => ({ dispose: () => {} }),
};

export const commands = {
  executeCommand: async (_id: string, ..._args: unknown[]) => undefined,
};

export const ProgressLocation = {
  Notification: 1,
};

export const ViewColumn = {
  Active: 1,
  Beside: 2,
};

export const QuickInputButtons = {
  Back: Symbol("Back"),
};

export class ThemeIcon {
  constructor(public id: string) {}
}

export class CancellationTokenSource {
  private cancelled = false;
  private readonly listeners = new Set<() => void>();

  readonly token = {
    get isCancellationRequested(): boolean {
      return this.cancelled;
    },
    onCancellationRequested: (listener: () => void) => {
      if (this.cancelled) listener();
      this.listeners.add(listener);
      return { dispose: () => this.listeners.delete(listener) };
    },
  };

  cancel(): void {
    this.cancelled = true;
    for (const listener of this.listeners) listener();
  }

  dispose(): void {
    this.listeners.clear();
  }
}

export class Uri {
  constructor(
    public readonly scheme: string,
    public readonly path: string,
    public readonly fsPath: string,
    public readonly authority = "",
    public readonly query = "",
    public readonly fragment = "",
  ) {}

  static file(p: string): Uri {
    return new Uri("file", p, p);
  }

  static joinPath(base: Uri, ...segments: string[]): Uri {
    const joined = [base.path, ...segments].filter(Boolean).join("/");
    return new Uri(base.scheme, joined, joined);
  }

  static parse(raw: string): Uri {
    const m = raw.match(/^([^:]+):(.*)$/);
    if (m) return new Uri(m[1], m[2], m[2]);
    return new Uri("file", raw, raw);
  }

  toString(): string {
    return `${this.scheme}:${this.path}`;
  }

  with(change: { scheme?: string; path?: string; fsPath?: string }): Uri {
    return new Uri(
      change.scheme ?? this.scheme,
      change.path ?? this.path,
      change.fsPath ?? this.fsPath,
    );
  }
}

export const CancellationError = class extends Error {};

export const extensions = {
  getExtension: (_id: string) => ({
    id: "yjdyamv.smart-archive",
    extensionUri: new Uri("file", "/ext", "/ext"),
  }),
};

export default {
  env,
  window,
  workspace,
  commands,
  extensions,
  ProgressLocation,
  ViewColumn,
  QuickInputButtons,
  ThemeIcon,
  CancellationTokenSource,
  Uri,
  CancellationError,
};
