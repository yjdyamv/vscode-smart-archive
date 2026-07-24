/**
 * Archive modification tests — Smart Archive VSCode Extension
 *
 * Tests for: add-to-archive, rename, delete, format conversion,
 * merge/split operations, encrypt/decrypt workflows.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as path from "path";
import * as fs from "fs";
import * as os from "os";
import {
  mkdirP,
  run7z,
  j7zCompress,
  j7zCompressDir,
  j7zDecompress,
  copyFS,
  buildTree,
  disposeJS7z,
  createWrapped,
  trackedJS7z,
  resetActiveInstances,
  disposeAllTracked,
} from "./shared-setup";

/* eslint-disable @typescript-eslint/no-explicit-any */

beforeEach(() => {
  resetActiveInstances();
});

afterEach(() => {
  disposeAllTracked();
});

const _td = fs.mkdtempSync(path.join(os.tmpdir(), "sat_"));
describe("add-to-archive", () => {
  it("individual file paths lose dir structure", async () => {
    const j = await trackedJS7z();
    j.FS.mkdir("/subdir");
    j.FS.writeFile("/subdir/a.txt", new Uint8Array(Buffer.from("a")));
    j.FS.writeFile("/subdir/b.txt", new Uint8Array(Buffer.from("b")));
    await run7z(j, ["a", "/test.7z", "-aot", "/subdir/a.txt", "/subdir/b.txt"]);
    const buf = Buffer.from(j.FS.readFile("/test.7z", { encoding: "binary" }));
    const f = await j7zDecompress(buf);
    expect(f["a.txt"]).toBe("a");
    expect(f["b.txt"]).toBe("b");
    expect(f["subdir/a.txt"]).toBeUndefined();
  });

  it("passing a directory preserves structure", async () => {
    const j = await trackedJS7z();
    j.FS.mkdir("/subdir");
    j.FS.writeFile("/subdir/a.txt", new Uint8Array(Buffer.from("a")));
    j.FS.writeFile("/subdir/b.txt", new Uint8Array(Buffer.from("b")));
    await run7z(j, ["a", "/test.7z", "-aot", "/subdir"]);
    const buf = Buffer.from(j.FS.readFile("/test.7z", { encoding: "binary" }));
    const f = await j7zDecompress(buf);
    expect(f["subdir/a.txt"]).toBe("a");
    expect(f["subdir/b.txt"]).toBe("b");
  });

  it("single file in directory preserves dir name", async () => {
    const j = await trackedJS7z();
    j.FS.mkdir("/subdir");
    j.FS.writeFile("/subdir/a.txt", new Uint8Array(Buffer.from("a")));
    await run7z(j, ["a", "/test.7z", "-aot", "/subdir"]);
    const buf = Buffer.from(j.FS.readFile("/test.7z", { encoding: "binary" }));
    const f = await j7zDecompress(buf);
    expect(f["subdir/a.txt"]).toBe("a");
  });

  it("deeply nested dir via first-level directory", async () => {
    const j = await trackedJS7z();
    mkdirP(j, "/a/b/c");
    j.FS.writeFile("/a/b/c/d.txt", new Uint8Array(Buffer.from("deep")));
    j.FS.writeFile("/a/b/e.txt", new Uint8Array(Buffer.from("e")));
    await run7z(j, ["a", "/test.7z", "-aot", "/a"]);
    const buf = Buffer.from(j.FS.readFile("/test.7z", { encoding: "binary" }));
    const f = await j7zDecompress(buf);
    expect(f["a/b/c/d.txt"]).toBe("deep");
    expect(f["a/b/e.txt"]).toBe("e");
  });

  it("root-level files via individual paths", async () => {
    const j = await trackedJS7z();
    j.FS.writeFile("/a.txt", new Uint8Array(Buffer.from("a")));
    j.FS.writeFile("/b.txt", new Uint8Array(Buffer.from("b")));
    await run7z(j, ["a", "/test.7z", "-aot", "/a.txt", "/b.txt"]);
    const buf = Buffer.from(j.FS.readFile("/test.7z", { encoding: "binary" }));
    const f = await j7zDecompress(buf);
    expect(f["a.txt"]).toBe("a");
    expect(f["b.txt"]).toBe("b");
  });

  it("createFolder: new directory with .smartarchive marker", async () => {
    const j = await trackedJS7z();
    j.FS.writeFile("/f.txt", new Uint8Array(Buffer.from("x")));
    await run7z(j, ["a", "/test.7z", "/f.txt"]);
    let buf = Buffer.from(j.FS.readFile("/test.7z", { encoding: "binary" }));

    const j2 = await trackedJS7z();
    j2.FS.writeFile("/test.7z", new Uint8Array(buf));
    mkdirP(j2, "/sub/newdir");
    j2.FS.writeFile("/sub/newdir/.smartarchive", new Uint8Array(Buffer.from(".")));
    await run7z(j2, ["a", "/test.7z", "-aot", "/sub"]);

    buf = Buffer.from(j2.FS.readFile("/test.7z", { encoding: "binary" }));
    const f = await j7zDecompress(buf);
    expect(f["f.txt"]).toBe("x");
    expect(f["sub/newdir/.smartarchive"]).toBe(".");

    const tree = buildTree(
      [
        { path: "f.txt", size: 1, type: "REGULAR_FILE" },
        { path: "sub/newdir/.smartarchive", size: 1, type: "REGULAR_FILE" },
      ],
      "test.7z",
    );
    expect(tree.length).toBe(2);
    const subDir = tree.find((n: any) => n.kind === "DIRECTORY" && n.name === "sub") as any;
    expect(subDir).toBeTruthy();
    expect(subDir!.children!.length).toBe(1);
    expect(subDir!.children![0].name).toBe("newdir");
    expect(subDir!.children![0].kind).toBe("DIRECTORY");
  });
});

// ════════════════════════════════════════════════════════════════════
// Rename
// ════════════════════════════════════════════════════════════════════


describe("rename", () => {
  it("simple file rename via 7z rn", async () => {
    const j = await trackedJS7z();
    j.FS.writeFile("/old.txt", new Uint8Array(Buffer.from("hello")));
    await run7z(j, ["a", "/test.7z", "/old.txt"]);
    let buf = Buffer.from(j.FS.readFile("/test.7z", { encoding: "binary" }));

    const j2 = await trackedJS7z();
    j2.FS.writeFile("/test.7z", new Uint8Array(buf));
    await run7z(j2, ["rn", "/test.7z", "old.txt", "new.txt"]);
    buf = Buffer.from(j2.FS.readFile("/test.7z", { encoding: "binary" }));

    const f = await j7zDecompress(buf);
    expect(f["new.txt"]).toBe("hello");
    expect(f["old.txt"]).toBeUndefined();
  });

  it("file in subdirectory", async () => {
    const j = await trackedJS7z();
    mkdirP(j, "/sub");
    j.FS.writeFile("/sub/old.txt", new Uint8Array(Buffer.from("x")));
    await run7z(j, ["a", "/test.7z", "/sub"]);
    let buf = Buffer.from(j.FS.readFile("/test.7z", { encoding: "binary" }));

    const j2 = await trackedJS7z();
    j2.FS.writeFile("/test.7z", new Uint8Array(buf));
    await run7z(j2, ["rn", "/test.7z", "sub/old.txt", "sub/new.txt"]);
    buf = Buffer.from(j2.FS.readFile("/test.7z", { encoding: "binary" }));

    const f = await j7zDecompress(buf);
    expect(f["sub/new.txt"]).toBe("x");
    expect(f["sub/old.txt"]).toBeUndefined();
  });

  it("move to different directory", async () => {
    const j = await trackedJS7z();
    mkdirP(j, "/a");
    mkdirP(j, "/b");
    j.FS.writeFile("/a/file.txt", new Uint8Array(Buffer.from("move")));
    await run7z(j, ["a", "/test.7z", "/a", "/b"]);
    let buf = Buffer.from(j.FS.readFile("/test.7z", { encoding: "binary" }));

    const j2 = await trackedJS7z();
    j2.FS.writeFile("/test.7z", new Uint8Array(buf));
    await run7z(j2, ["rn", "/test.7z", "a/file.txt", "b/file.txt"]);
    buf = Buffer.from(j2.FS.readFile("/test.7z", { encoding: "binary" }));

    const f = await j7zDecompress(buf);
    expect(f["b/file.txt"]).toBe("move");
    expect(f["a/file.txt"]).toBeUndefined();
  });
});

// ════════════════════════════════════════════════════════════════════
// Format / encoding utilities
// ════════════════════════════════════════════════════════════════════


describe("format conversion", () => {
  const files27z = { "/sub/a.txt": "one", "/c.txt": "two" };

  it("7z to zip round-trip", async () => {
    const src7z = await j7zCompressDir(files27z, "/_s.7z");
    const orig = await j7zDecompress(src7z);
    expect(orig["sub/a.txt"]).toBe("one");

    const files: Record<string, string> = {};
    for (const [k, v] of Object.entries(orig)) files["/" + k] = v;
    const zip = await j7zCompressDir(files, "/_d.zip");
    const conv = await j7zDecompress(zip);
    expect(Object.values(conv)).toContain("one");
    expect(Object.values(conv)).toContain("two");
  });

  it("7z to tar round-trip", async () => {
    const src7z = await j7zCompressDir(files27z, "/_s2.7z");
    const orig = await j7zDecompress(src7z);
    expect(orig["sub/a.txt"]).toBe("one");

    const files: Record<string, string> = {};
    for (const [k, v] of Object.entries(orig)) files["/" + k] = v;
    const tar = await j7zCompressDir(files, "/_d.tar");
    const conv = await j7zDecompress(tar);
    expect(Object.values(conv)).toContain("one");
    expect(Object.values(conv)).toContain("two");
  });
});

// ════════════════════════════════════════════════════════════════════
// Merge split volumes → single archive
// ════════════════════════════════════════════════════════════════════


describe("merge/split operations", () => {
  it("merge: split 7z back to single", async () => {
    const j1 = await trackedJS7z();
    j1.FS.writeFile("/big.txt", new Uint8Array(Buffer.from("x".repeat(16384))));
    await run7z(j1, ["a", "/_m.7z", "/big.txt", "-v100b"]);
    const parts = j1.FS.readdir("/").filter((e) => e.startsWith("_m.7z."));
    expect(parts.length).toBeGreaterThanOrEqual(2);

    const j2 = await trackedJS7z();
    for (const p of parts) {
      const data = j1.FS.readFile("/" + p, { encoding: "binary" });
      j2.FS.writeFile("/" + p, new Uint8Array(data));
    }
    j2.FS.mkdir("/o");
    await run7z(j2, ["x", "/_m.7z.001", "-o/o"]);
    const res: Record<string, string> = {};
    copyFS(j2, "/o", "", res);
    expect(Object.values(res).some((v) => v.length === 16384)).toBe(true);

    const merged = await j7zCompress(res as Record<string, string>, "/_merged.7z");
    const f = await j7zDecompress(merged);
    expect(Object.keys(f).length).toBe(1);
    expect(Object.values(f)[0].length).toBe(16384);
  });

  it("split: single 7z to volumes", async () => {
    const j1 = await trackedJS7z();
    j1.FS.writeFile("/big.txt", new Uint8Array(Buffer.from("x".repeat(16384))));
    await run7z(j1, ["a", "/_s.7z", "/big.txt"]);
    const srcBuf = Buffer.from(j1.FS.readFile("/_s.7z", { encoding: "binary" }));

    const j2 = await trackedJS7z();
    j2.FS.writeFile("/_s.7z", new Uint8Array(srcBuf));
    j2.FS.mkdir("/_t");
    await run7z(j2, ["x", "/_s.7z", "-o/_t"]);

    const j3 = await trackedJS7z();
    const files: Record<string, string> = {};
    copyFS(j2, "/_t", "", files);
    for (const [k, v] of Object.entries(files)) {
      const d = path.posix.dirname(k);
      if (d && d !== ".") mkdirP(j3, "/" + d);
      j3.FS.writeFile("/" + k, new Uint8Array(Buffer.from(v)));
    }
    j3.FS.mkdir("/_o");
    const tops = [...new Set(Object.keys(files).map((f) => "/" + f.split("/")[0]))];
    await run7z(j3, ["a", "/_o/_d.7z", ...tops, "-v100b"]);

    const parts = j3.FS.readdir("/_o").filter((e) => e.startsWith("_d.7z."));
    expect(parts.length).toBeGreaterThanOrEqual(2);

    const j4 = await trackedJS7z();
    for (const p of parts) {
      const data = j3.FS.readFile("/_o/" + p, { encoding: "binary" });
      j4.FS.writeFile("/" + p, new Uint8Array(data));
    }
    j4.FS.mkdir("/chk");
    await run7z(j4, ["x", "/_d.7z.001", "-o/chk"]);
    const dec: Record<string, string> = {};
    copyFS(j4, "/chk", "", dec);
    expect(Object.values(dec).some((v) => v.length === 16384)).toBe(true);
  });
});

// ════════════════════════════════════════════════════════════════════
// Encrypt / decrypt
// ════════════════════════════════════════════════════════════════════


describe("encrypt/decrypt", () => {
  it("convert: encrypted 7z round-trip preserves encryption", async () => {
    const pw = "p4ssw0rd";
    const src = await j7zCompressDir(
      { "/sub/a.txt": "one", "/c.txt": "two" },
      "/_enc.7z",
      [`-p${pw}`, "-mhe=on"],
    );
    const orig = await j7zDecompress(src, pw);
    expect(orig["sub/a.txt"]).toBe("one");

    const files: Record<string, string> = {};
    for (const [k, v] of Object.entries(orig)) files["/" + k] = v;
    const out = await j7zCompressDir(files, "/_conv.7z", [`-p${pw}`, "-mhe=on"]);
    const conv = await j7zDecompress(out, pw);
    expect(conv["sub/a.txt"]).toBe("one");
    expect(conv["c.txt"]).toBe("two");

    await expect(j7zDecompress(out, "wrong")).rejects.toThrow(/7z exit/);
  });

  it("decrypt: encrypted 7z → non-encrypted", async () => {
    const pw = "s3cret";
    const src = await j7zCompressDir(
      { "/x.txt": "secret-data" },
      "/_enc2.7z",
      [`-p${pw}`, "-mhe=on"],
    );
    await expect(j7zDecompress(src)).rejects.toThrow(/7z exit/);

    const decrypted = await j7zDecompress(src, pw);
    const files: Record<string, string> = {};
    for (const [k, v] of Object.entries(decrypted)) files["/" + k] = v;
    const stripped = await j7zCompressDir(files, "/_dec.7z");
    const res = await j7zDecompress(stripped);
    expect(res["x.txt"]).toBe("secret-data");
  });

  it("encrypt: non-encrypted 7z → encrypted", async () => {
    const pw = "newpw";
    const plain = await j7zCompressDir({ "/d.txt": "hello" }, "/_pl.7z");
    const orig = await j7zDecompress(plain);
    expect(orig["d.txt"]).toBe("hello");

    const files: Record<string, string> = {};
    for (const [k, v] of Object.entries(orig)) files["/" + k] = v;
    const enc = await j7zCompressDir(files, "/_enc3.7z", [`-p${pw}`, "-mhe=on"]);
    await expect(j7zDecompress(enc)).rejects.toThrow(/7z exit/);
    const res = await j7zDecompress(enc, pw);
    expect(res["d.txt"]).toBe("hello");
  });

  it("decrypt: encrypted split 7z → non-encrypted split", async () => {
    const pw = "splitpw";
    const j1 = await trackedJS7z();
    j1.FS.writeFile("/big.txt", new Uint8Array(Buffer.from("y".repeat(16384))));
    await run7z(j1, ["a", "/_es.7z", "/big.txt", `-p${pw}`, "-mhe=on", "-v100b"]);
    const parts = j1.FS.readdir("/").filter((e) => e.startsWith("_es.7z."));
    expect(parts.length).toBeGreaterThanOrEqual(2);

    const j2 = await trackedJS7z();
    for (const p of parts) {
      const d = j1.FS.readFile("/" + p, { encoding: "binary" });
      j2.FS.writeFile("/" + p, new Uint8Array(d));
    }
    j2.FS.mkdir("/o");
    await run7z(j2, ["x", "/_es.7z.001", "-o/o", `-p${pw}`]);
    const files: Record<string, string> = {};
    copyFS(j2, "/o", "", files);
    expect(files["big.txt"]?.length).toBe(16384);

    const j3 = await trackedJS7z();
    for (const [k, v] of Object.entries(files)) {
      const d = path.posix.dirname(k);
      if (d && d !== ".") mkdirP(j3, "/" + d);
      j3.FS.writeFile("/" + k, new Uint8Array(Buffer.from(v)));
    }
    j3.FS.mkdir("/oo");
    const tops = [...new Set(Object.keys(files).map((f) => "/" + f.split("/")[0]))];
    await run7z(j3, ["a", "/oo/_ds.7z", ...tops, "-v100b"]);

    const newParts = j3.FS.readdir("/oo").filter((e) => e.startsWith("_ds.7z."));
    expect(newParts.length).toBeGreaterThanOrEqual(2);

    const j4 = await trackedJS7z();
    for (const p of newParts) {
      const d = j3.FS.readFile("/oo/" + p, { encoding: "binary" });
      j4.FS.writeFile("/" + p, new Uint8Array(d));
    }
    j4.FS.mkdir("/chk2");
    await run7z(j4, ["x", "/_ds.7z.001", "-o/chk2"]);
    const dec: Record<string, string> = {};
    copyFS(j4, "/chk2", "", dec);
    expect(dec["big.txt"]?.length).toBe(16384);
  });

  it("encrypt: non-encrypted split 7z → encrypted split", async () => {
    const pw = "encsplit";
    const j1 = await trackedJS7z();
    j1.FS.writeFile("/med.txt", new Uint8Array(Buffer.from("z".repeat(16384))));
    await run7z(j1, ["a", "/_ps.7z", "/med.txt", "-v100b"]);
    const parts = j1.FS.readdir("/").filter((e) => e.startsWith("_ps.7z."));
    expect(parts.length).toBeGreaterThanOrEqual(2);

    const j2 = await trackedJS7z();
    for (const p of parts) {
      const d = j1.FS.readFile("/" + p, { encoding: "binary" });
      j2.FS.writeFile("/" + p, new Uint8Array(d));
    }
    j2.FS.mkdir("/o2");
    await run7z(j2, ["x", "/_ps.7z.001", "-o/o2"]);
    const files: Record<string, string> = {};
    copyFS(j2, "/o2", "", files);

    const j3 = await trackedJS7z();
    for (const [k, v] of Object.entries(files)) {
      const d = path.posix.dirname(k);
      if (d && d !== ".") mkdirP(j3, "/" + d);
      j3.FS.writeFile("/" + k, new Uint8Array(Buffer.from(v)));
    }
    j3.FS.mkdir("/oo2");
    const tops = [...new Set(Object.keys(files).map((f) => "/" + f.split("/")[0]))];
    await run7z(j3, ["a", "/oo2/_es2.7z", ...tops, `-p${pw}`, "-mhe=on", "-v100b"]);

    const newParts = j3.FS.readdir("/oo2").filter((e) => e.startsWith("_es2.7z."));
    expect(newParts.length).toBeGreaterThanOrEqual(2);

    const j4 = await trackedJS7z();
    for (const p of newParts) {
      const d = j3.FS.readFile("/oo2/" + p, { encoding: "binary" });
      j4.FS.writeFile("/" + p, new Uint8Array(d));
    }
    j4.FS.mkdir("/chk3");
    await expect(run7z(j4, ["x", "-p-", "/_es2.7z.001", "-o/chk3"])).rejects.toThrow(/7z exit/);

    const j5 = await trackedJS7z();
    for (const p of newParts) {
      const d = j3.FS.readFile("/oo2/" + p, { encoding: "binary" });
      j5.FS.writeFile("/" + p, new Uint8Array(d));
    }
    j5.FS.mkdir("/chk3b");
    await run7z(j5, ["x", "/_es2.7z.001", "-o/chk3b", `-p${pw}`]);
    const enc: Record<string, string> = {};
    copyFS(j5, "/chk3b", "", enc);
    expect(enc["med.txt"]?.length).toBe(16384);
  });
});

// ════════════════════════════════════════════════════════════════════
// Exclusion logic (uses direct import from src/utils/exclude)
// ════════════════════════════════════════════════════════════════════


describe("delete from archive (7z d on tar)", () => {
  it("full tar.gz flow: decompress → 7z d → recompress does not hang", async () => {
    const files = {
      "/myDir/a.txt": "hello",
      "/myDir/b.txt": "world",
    };
    // 1. Create tar.gz using createWrapped
    const tarGz = await createWrapped(files, "tar.gz");

    // 2. Decompress the outer layer to get inner.tar
    const j1 = await trackedJS7z();
    j1.FS.writeFile("/archive.tar.gz", new Uint8Array(tarGz));
    j1.FS.mkdir("/_extract");
    await run7z(j1, ["x", "/archive.tar.gz", "-o/_extract", "-y"]);
    const top = j1.FS.readdir("/_extract").filter((e: string) => e !== "." && e !== "..");
    const innerTarName = top.find((e: string) => e.endsWith(".tar"))!;
    const innerTarData = new Uint8Array(
      j1.FS.readFile(`/_extract/${innerTarName}`, { encoding: "binary" }),
    );
    disposeJS7z(j1);

    // 3. Create second instance, write inner.tar, run 7z d
    const j2 = await trackedJS7z();
    j2.FS.writeFile("/inner.tar", innerTarData);

    // Use expanded paths (the fix)
    const deletePaths = ["myDir", "myDir/a.txt", "myDir/b.txt"];
    await expect(
      Promise.race([
        run7z(j2, ["d", "/inner.tar", "-y", ...deletePaths]),
        new Promise((_, reject) => setTimeout(() => reject(new Error("TIMEOUT: 7z d hung in full flow")), 10_000)),
      ]),
    ).resolves.toBeUndefined();

    // 4. Read modified tar
    const modifiedTar = new Uint8Array(
      j2.FS.readFile("/inner.tar", { encoding: "binary" }),
    );

    // 5. Recompress to gzip using a FRESH instance
    // Reusing the same js7z2 instance after 7z d HANGS on 7z a!
    const j2b = await trackedJS7z();
    j2b.FS.writeFile("/_re.tar", modifiedTar);
    await expect(
      Promise.race([
        run7z(j2b, ["a", "/_re.tar.gz", "/_re.tar"]),
        new Promise((_, reject) => setTimeout(() => reject(new Error("TIMEOUT: 7z a recompression hung")), 10_000)),
      ]),
    ).resolves.toBeUndefined();

    const compressedData = new Uint8Array(
      j2b.FS.readFile("/_re.tar.gz", { encoding: "binary" }),
    );
    disposeJS7z(j2);
    disposeJS7z(j2b);

    // 6. Extract and verify
    const j3 = await trackedJS7z();
    j3.FS.writeFile("/final.tar.gz", compressedData);
    j3.FS.mkdir("/_final");
    await run7z(j3, ["x", "/final.tar.gz", "-o/_final", "-y"]);
    const finalTop = j3.FS.readdir("/_final").filter((e: string) => e !== "." && e !== "..");
    const finalTarName = finalTop.find((e: string) => e.endsWith(".tar"))!;
    const finalTarData = new Uint8Array(
      j3.FS.readFile(`/_final/${finalTarName}`, { encoding: "binary" }),
    );

    const j4 = await trackedJS7z();
    j4.FS.writeFile("/_t.tar", finalTarData);
    let finalStdout = "";
    j4.print = (t: string) => { finalStdout += t + "\n"; };
    j4.printErr = () => {};
    await new Promise<void>((resolve, reject) => {
      j4.onExit = (c) => (c === 0 ? resolve() : reject(new Error(`l exit ${c}`)));
      j4.callMain(["l", "-slt", "-sccUTF-8", "/_t.tar"]);
    });

    expect(finalStdout).not.toContain("myDir/a.txt");
    expect(finalStdout).not.toContain("myDir/b.txt");
  }, 30_000);
});

// ════════════════════════════════════════════════════════════════════
// pruneOldPreviews (requires compiled module, may not be available)
// ════════════════════════════════════════════════════════════════════

// ════════════════════════════════════════════════════════════════════
// Workspace compress save path
// ════════════════════════════════════════════════════════════════════
