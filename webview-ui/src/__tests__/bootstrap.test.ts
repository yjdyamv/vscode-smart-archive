/**
 * Bootstrap tests — initial-state injection parsing.
 *
 * loadInitialState reads the JSON <script> blocks the host injects before
 * the bundle loads. These tests pin the tag contract and the fallbacks for
 * missing / malformed blocks.
 */

import { describe, it, expect, beforeEach } from "vitest";
import { loadInitialState } from "../bootstrap";

function setTag(id: string, json: string): void {
  const el = document.createElement("script");
  el.id = id;
  el.type = "application/json";
  el.textContent = json;
  document.body.appendChild(el);
}

describe("loadInitialState", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
  });

  it("parses every injected block", () => {
    setTag("_xTree", JSON.stringify([{ name: "a", path: "a", size: 0, kind: "DIRECTORY" }]));
    setTag(
      "_xProps",
      JSON.stringify({
        name: "x.7z",
        format: "7z",
        count: 3,
        files: 2,
        dirs: 1,
        size: "1 KB",
        ratio: 0.5,
      }),
    );
    setTag("_xFiles", "2");
    setTag("_xDirs", "1");
    setTag("_xViewState", JSON.stringify("content"));
    setTag("_xToast", JSON.stringify("hello"));
    setTag("_xReadOnly", "true");
    setTag("_xIsSplit", "false");
    setTag("_xCanSplit", "true");
    setTag("_xIsEncrypted", "false");
    setTag("_xCanEncrypt", "true");
    setTag("_xDescCounts", JSON.stringify({ a: { files: 2, dirs: 0, size: 10 } }));
    setTag("_xExpanded", JSON.stringify(["a"]));
    setTag("_xStrings", JSON.stringify({ "ui.extract": "提取", "ui.merge": "合并" }));

    const s = loadInitialState();
    expect(s.viewState).toBe("content");
    expect(s.tree).toHaveLength(1);
    expect(s.props?.format).toBe("7z");
    expect(s.files).toBe(2);
    expect(s.dirs).toBe(1);
    expect(s.toast).toBe("hello");
    expect(s.readOnly).toBe(true);
    expect(s.isSplit).toBe(false);
    expect(s.canSplit).toBe(true);
    expect(s.isEncrypted).toBe(false);
    expect(s.canEncrypt).toBe(true);
    expect(s.descCounts.a.size).toBe(10);
    expect(s.expanded).toEqual(["a"]);
    expect(s.ui["ui.extract"]).toBe("提取");
    expect(s.ui["ui.merge"]).toBe("合并");
  });

  it("parses the password view state", () => {
    setTag("_xTree", "[]");
    setTag("_xViewState", JSON.stringify("password"));
    setTag("_xProps", "null");
    const s = loadInitialState();
    expect(s.viewState).toBe("password");
    expect(s.props).toBeNull();
  });

  it("defaults when tags are missing", () => {
    const s = loadInitialState();
    expect(s.tree).toEqual([]);
    expect(s.props).toBeNull();
    expect(s.files).toBe(0);
    expect(s.dirs).toBe(0);
    expect(s.viewState).toBeNull();
    expect(s.toast).toBeNull();
    expect(s.readOnly).toBe(false);
    expect(s.isSplit).toBe(false);
    expect(s.canSplit).toBe(false);
    expect(s.isEncrypted).toBe(false);
    expect(s.canEncrypt).toBe(false);
    expect(s.descCounts).toEqual({});
    expect(s.expanded).toEqual([]);
    expect(s.ui).toEqual({});
  });

  it("falls back on malformed JSON", () => {
    setTag("_xTree", "{broken");
    setTag("_xFiles", "not-a-number");
    const s = loadInitialState();
    expect(s.tree).toEqual([]);
    expect(s.files).toBe(0);
  });
});
