/**
 * Volume size utilities — Smart Archiver VSCode Extension
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
 * Returns the volume size presets shown in the pickers: your own map if you set
 * one, otherwise the built-in ladder.
 *
 * Replacing rather than merging is deliberate — two tables stitched together
 * (built-ins then yours) is exactly the list nobody can read.
 */
export function getVolumeSizes(): VolumeSizeItem[] {
  const config = vscode.workspace.getConfiguration("smart-archiver");
  const map = config.get<Record<string, string>>("volumes.sizes", {});
  const entries = Object.entries(map);
  if (entries.length === 0) {
    return VOLUME_SIZES.map((v) => ({ ...v, description: describeVolume(v.label, v.value) }));
  }
  return entries.map(([label, value]) => ({
    label,
    value,
    description: describeVolume(label, value),
  }));
}
