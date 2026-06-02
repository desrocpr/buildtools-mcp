import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";

import {
  decrypt,
  encrypt,
  ENCRYPTION_VERSION,
  loadEncryptionKey,
  safeEqual,
} from "../encryption.js";

describe("encryption", () => {
  const KEY = randomBytes(32);

  it("round-trips ASCII plaintext", () => {
    const payload = encrypt("hello world", KEY);
    expect(decrypt(payload, KEY)).toBe("hello world");
  });

  it("round-trips unicode plaintext", () => {
    const text = "señor — résumé · 你好世界 · 🔐";
    expect(decrypt(encrypt(text, KEY), KEY)).toBe(text);
  });

  it("produces different ciphertexts for the same plaintext (random IV)", () => {
    const a = encrypt("same input", KEY);
    const b = encrypt("same input", KEY);
    expect(a.equals(b)).toBe(false);
  });

  it("ciphertext starts with the version byte", () => {
    const payload = encrypt("x", KEY);
    expect(payload[0]).toBe(ENCRYPTION_VERSION);
  });

  it("rejects decryption with the wrong key", () => {
    const payload = encrypt("secret", KEY);
    const wrong = randomBytes(32);
    expect(() => decrypt(payload, wrong)).toThrow();
  });

  it("rejects tampered ciphertext (auth tag fail)", () => {
    const payload = encrypt("the original", KEY);
    // Flip one bit in the ciphertext body (last byte).
    const tampered = Buffer.from(payload);
    tampered[tampered.length - 1] ^= 0x01;
    expect(() => decrypt(tampered, KEY)).toThrow();
  });

  it("rejects an unsupported version byte", () => {
    const payload = encrypt("hello", KEY);
    payload[0] = 99;
    expect(() => decrypt(payload, KEY)).toThrow(/unsupported encryption version/);
  });

  it("rejects payloads shorter than the header", () => {
    expect(() => decrypt(Buffer.from([1, 2, 3]), KEY)).toThrow(/too short/);
  });

  it("rejects keys of the wrong length", () => {
    const short = randomBytes(16);
    expect(() => encrypt("x", short)).toThrow(/32 bytes/);
    expect(() => decrypt(encrypt("x", KEY), short)).toThrow(/32 bytes/);
  });
});

describe("loadEncryptionKey", () => {
  it("decodes a base64 32-byte key", () => {
    const key = randomBytes(32);
    const env = { MCP_ENCRYPTION_KEY: key.toString("base64") };
    expect(loadEncryptionKey(env).equals(key)).toBe(true);
  });

  it("throws when MCP_ENCRYPTION_KEY is missing", () => {
    expect(() => loadEncryptionKey({})).toThrow(/required/);
  });

  it("throws when the key decodes to the wrong length", () => {
    const env = { MCP_ENCRYPTION_KEY: randomBytes(16).toString("base64") };
    expect(() => loadEncryptionKey(env)).toThrow(/32 bytes/);
  });
});

describe("safeEqual", () => {
  it("returns true for identical buffers", () => {
    expect(safeEqual(Buffer.from("abc"), Buffer.from("abc"))).toBe(true);
  });

  it("returns false for differing buffers", () => {
    expect(safeEqual(Buffer.from("abc"), Buffer.from("abd"))).toBe(false);
  });

  it("returns false for differently-sized buffers", () => {
    expect(safeEqual(Buffer.from("abc"), Buffer.from("abcd"))).toBe(false);
  });
});
