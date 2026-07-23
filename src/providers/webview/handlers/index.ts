/**
 * Webview message handler barrel — command → handler map.
 *
 * @module providers/webview/handlers/index
 */

import type { MessageHandler } from "./types";
import { handlePassword } from "./password";
import { handleExtractAll } from "./extractAll";
import { handleExtractSelected } from "./extractSelected";
import { handleCopy } from "./copy";
import { handleDelete } from "./deleteEntries";
import { handleRename } from "./rename";
import { handleAddFiles } from "./addFiles";
import { handleDropFiles } from "./dropFiles";
import { handleNewFolder } from "./newFolder";
import { handlePreview } from "./preview";
import { handleMerge } from "./merge";
import { handleSplit } from "./split";
import { handleConvert } from "./convert";
import { handleEncrypt } from "./encrypt";
import { handleDecrypt } from "./decrypt";
import { handleTest } from "./test";

export const HANDLERS: Record<string, MessageHandler> = {
  pw: handlePassword,
  extAll: handleExtractAll,
  extSel: handleExtractSelected,
  copy: handleCopy,
  delSel: handleDelete,
  renamePrompt: handleRename,
  addFiles: handleAddFiles,
  dropFiles: handleDropFiles,
  newFolderPrompt: handleNewFolder,
  preview: handlePreview,
  merge: handleMerge,
  split: handleSplit,
  convert: handleConvert,
  encrypt: handleEncrypt,
  decrypt: handleDecrypt,
  test: handleTest,
};
