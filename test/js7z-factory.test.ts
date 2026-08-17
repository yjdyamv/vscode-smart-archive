/**
 * js7z-factory contract tests — Smart Archiver VSCode Extension
 *
 * Locks the compatibility shim over the bundled 7-Zip ZS WASM engine:
 * shared instance, per-call FS reset, post-construction print/printErr
 * rebinding, and callMain → onExit.
 */

import { describe, it, expect } from "vitest";

import { JS7z } from "../src/engines/js7z-factory";
import { disposeJS7z } from "./helpers";

describe("js7z factory (7zz-wasm)", () => {
  it("returns one shared instance per module and resets the VFS per call", async () => {
    const first = await JS7z();
    first.FS.mkdir("/in");
    first.FS.writeFile("/in/x.txt", new Uint8Array([1, 2, 3]));

    const second = await JS7z();
    expect(second).toBe(first);
    expect(() => second.FS.stat("/in")).toThrow();
    const rootEntries = second.FS.readdir("/");
    expect(rootEntries).not.toContain("in");
    expect(rootEntries).not.toContain("x.txt");
  });

  it("supports assigning print/printErr after construction", async () => {
    const inst = await JS7z();
    let stdout = "";
    inst.print = (text: string) => {
      stdout += text + "\n";
    };
    inst.printErr = () => {};

    const code = await new Promise<number>((resolve, reject) => {
      inst.onExit = (exitCode: number) => {
        if (exitCode === 0) resolve(exitCode);
        else reject(new Error(`7zz exited with ${exitCode}`));
      };
      inst.callMain(["--help"]);
    });

    expect(code).toBe(0);
    expect(stdout).toContain("7-Zip");
  });

  it("keeps working after disposeJS7z (shared no-op lifecycle)", async () => {
    const inst = await JS7z();
    disposeJS7z(inst);

    const code = inst.callMain(["--help"]);
    expect(typeof code).toBe("number");
    expect(code).toBe(0);
  });
});
