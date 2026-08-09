/**
 * Password vault unit tests — Smart Archive VSCode Extension
 *
 * Session-scoped SecretStorage password store: save after successful
 * unlock, read for same-session re-opens, delete everything on
 * deactivate. The SecretStorage is a structural type — tests inject an
 * in-memory fake.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  disposePasswordVault,
  getCachedArchivePassword,
  initPasswordVault,
  saveArchivePassword,
} from "../src/providers/passwordVault";

interface FakeSecrets {
  store: Map<string, string>;
  api: {
    store(key: string, value: string): Promise<void>;
    get(key: string): Promise<string | undefined>;
    delete(key: string): Promise<void>;
  };
}

function fakeSecretStorage(): FakeSecrets {
  const store = new Map<string, string>();
  return {
    store,
    api: {
      store: async (k: string, v: string) => {
        store.set(k, v);
      },
      get: async (k: string) => store.get(k),
      delete: async (k: string) => {
        store.delete(k);
      },
    },
  };
}

let secrets: FakeSecrets;

beforeEach(() => {
  secrets = fakeSecretStorage();
  initPasswordVault(secrets.api);
});

afterEach(async () => {
  await disposePasswordVault();
});

describe("passwordVault", () => {
  it("stores and reads back a verified password", async () => {
    await saveArchivePassword("/data/secret.7z", "hunter2");
    expect(await getCachedArchivePassword("/data/secret.7z")).toBe("hunter2");
  });

  it("keeps passwords of different archives separate", async () => {
    await saveArchivePassword("/data/a.7z", "aaa");
    await saveArchivePassword("/data/b.7z", "bbb");
    expect(await getCachedArchivePassword("/data/a.7z")).toBe("aaa");
    expect(await getCachedArchivePassword("/data/b.7z")).toBe("bbb");
  });

  it("keys carry a session id plus a hash, never the archive path", async () => {
    await saveArchivePassword("/data/very/private/secret.7z", "pw");
    const key = [...secrets.store.keys()][0];
    expect(key).not.toContain("very");
    expect(key).not.toContain("private");
    expect(key).toMatch(/^pw:[0-9a-f-]{36}:[0-9a-f]{64}$/);
  });

  it("a new session cannot read the previous session's password", async () => {
    await saveArchivePassword("/data/a.7z", "old-session-pw");
    await disposePasswordVault(); // session ends (close/update/crash)
    initPasswordVault(secrets.api); // fresh session id

    expect(await getCachedArchivePassword("/data/a.7z")).toBeUndefined();
  });

  it("a new session reads only passwords saved in it", async () => {
    await disposePasswordVault();
    initPasswordVault(secrets.api);
    await saveArchivePassword("/data/a.7z", "new-session-pw");
    expect(await getCachedArchivePassword("/data/a.7z")).toBe("new-session-pw");
  });

  it("ignores empty passwords", async () => {
    await saveArchivePassword("/data/a.7z", "");
    expect(secrets.store.size).toBe(0);
  });

  it("returns undefined when nothing was stored", async () => {
    expect(await getCachedArchivePassword("/data/never.7z")).toBeUndefined();
  });

  it("clears every password on dispose (session end)", async () => {
    await saveArchivePassword("/data/a.7z", "aaa");
    await saveArchivePassword("/data/b.7z", "bbb");
    await disposePasswordVault();
    expect(secrets.store.size).toBe(0);
    expect(await getCachedArchivePassword("/data/a.7z")).toBeUndefined();
  });
});
