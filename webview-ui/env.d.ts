/// <reference types="vite/client" />

declare module "*.vue" {
  import type { DefineComponent } from "vue";
  const component: DefineComponent<object, object, unknown>;
  export default component;
}

interface VscodeApi {
  postMessage(message: unknown): void;
  getState(): unknown;
  setState(state: unknown): void;
}

declare function acquireVsCodeApi(): VscodeApi;

interface Window {
  _xProps?: ArchiveProps;
  _xTree?: TreeNodeData[];
  _xFiles?: number;
  _xDirs?: number;
  _xNoisy?: string[];
  _xToast?: string;
  _xViewState?: string;
  _xReadOnly?: boolean;
  _xExpanded?: string[];
  _xIsSplit?: boolean;
  _xCanSplit?: boolean;
  _xIsEncrypted?: boolean;
  _xCanEncrypt?: boolean;
  _xDescCounts?: Record<string, { files: number; dirs: number; size: number }>;
}
