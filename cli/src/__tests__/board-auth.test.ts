import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  getStoredBoardCredential,
  readBoardAuthStore,
  removeStoredBoardCredential,
  setStoredBoardCredential,
} from "../client/board-auth.js";

function createTempAuthPath(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aoa-cli-auth-"));
  return path.join(dir, "auth.json");
}

describe("board auth store", () => {
  it("returns an empty store when the file does not exist", () => {
    const authPath = createTempAuthPath();
    expect(readBoardAuthStore(authPath)).toEqual({
      version: 1,
      credentials: {},
    });
  });

  it("stores and retrieves credentials by normalized api base", () => {
    const authPath = createTempAuthPath();
    setStoredBoardCredential({
      apiBase: "http://localhost:3100/",
      token: "aoa_board_token123",
      userId: "user-1",
      storePath: authPath,
    });

    const cred = getStoredBoardCredential("http://localhost:3100", authPath);
    expect(cred).toMatchObject({
      apiBase: "http://localhost:3100",
      token: "aoa_board_token123",
      userId: "user-1",
    });
    expect(cred?.createdAt).toBeTruthy();
    expect(cred?.updatedAt).toBeTruthy();
  });

  it("normalizes trailing slashes in api base", () => {
    const authPath = createTempAuthPath();
    setStoredBoardCredential({
      apiBase: "http://localhost:3100///",
      token: "aoa_board_abc",
      storePath: authPath,
    });

    expect(getStoredBoardCredential("http://localhost:3100", authPath)).toMatchObject({
      apiBase: "http://localhost:3100",
      token: "aoa_board_abc",
    });
  });

  it("removes stored credentials", () => {
    const authPath = createTempAuthPath();
    setStoredBoardCredential({
      apiBase: "http://localhost:3100",
      token: "aoa_board_token123",
      storePath: authPath,
    });

    expect(removeStoredBoardCredential("http://localhost:3100", authPath)).toBe(true);
    expect(getStoredBoardCredential("http://localhost:3100", authPath)).toBeNull();
  });

  it("returns false when removing a non-existent credential", () => {
    const authPath = createTempAuthPath();
    expect(removeStoredBoardCredential("http://localhost:9999", authPath)).toBe(false);
  });

  it("preserves createdAt when updating an existing credential", () => {
    const authPath = createTempAuthPath();
    const first = setStoredBoardCredential({
      apiBase: "http://localhost:3100",
      token: "aoa_board_first",
      storePath: authPath,
    });

    const second = setStoredBoardCredential({
      apiBase: "http://localhost:3100",
      token: "aoa_board_second",
      userId: "user-2",
      storePath: authPath,
    });

    expect(second.createdAt).toBe(first.createdAt);
    expect(second.token).toBe("aoa_board_second");
    expect(second.userId).toBe("user-2");
  });

  it("stores multiple credentials for different api bases", () => {
    const authPath = createTempAuthPath();
    setStoredBoardCredential({
      apiBase: "http://localhost:3100",
      token: "aoa_board_local",
      storePath: authPath,
    });
    setStoredBoardCredential({
      apiBase: "https://aoa.example.com",
      token: "aoa_board_remote",
      storePath: authPath,
    });

    expect(getStoredBoardCredential("http://localhost:3100", authPath)?.token).toBe("aoa_board_local");
    expect(getStoredBoardCredential("https://aoa.example.com", authPath)?.token).toBe("aoa_board_remote");

    const store = readBoardAuthStore(authPath);
    expect(Object.keys(store.credentials)).toHaveLength(2);
  });

  it("writes auth file with restrictive permissions (mode 0o600)", () => {
    if (process.platform === "win32") return; // stat.mode not reliable on Windows
    const authPath = createTempAuthPath();
    setStoredBoardCredential({
      apiBase: "http://localhost:3100",
      token: "aoa_board_secret",
      storePath: authPath,
    });

    const stat = fs.statSync(authPath);
    // eslint-disable-next-line no-bitwise
    expect(stat.mode & 0o777).toBe(0o600);
  });
});
