/**
 * Volume size utilities — Smart Archive VSCode Extension
 *
 * Config-dependent volume-size helpers (host-side UI only).
 * Pure helpers live in utils/volume-sizes-core.
 *
 * @module utils/volume-sizes
 */

import * as vscode from "vscode";
import { VOLUME_SIZES, toBinaryVolumeSize, describeVolume } from "./volume-sizes-core";
import type { VolumeSizeItem } from "./volume-sizes-core";

export { VOLUME_SIZES, toBinaryVolumeSize, describeVolume };
export type { VolumeSizeItem };

/**
 * Returns the user-configured volume size presets, falling back to the
 * built-in VOLUME_SIZES when no explicit user config is set.
 *
 * Uses `inspect` so we only return values the user explicitly wrote,
 * avoiding unwanted merging with the package.json default.
 */
export function getVolumeSizes(): VolumeSizeItem[] {
  const config = vscode.workspace.getConfiguration("smart-archive");
  const inspected = config.inspect<Record<string, string>>("volumeSizes");
  const userValue =
    inspected?.workspaceFolderValue ?? inspected?.workspaceValue ?? inspected?.globalValue;
  if (userValue && Object.keys(userValue).length > 0) {
    return Object.entries(userValue).map(([label, value]) => ({
      label,
      value,
      description: describeVolume(label, value),
    }));
  }
  return VOLUME_SIZES.map((v) => ({
    ...v,
    description: describeVolume(v.label, v.value),
  }));
}
