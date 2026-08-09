import { describe, expect, test } from "vitest";
import { isHttpUrl, normalizeViewUrl } from "@/lib/view/url";

describe("normalizeViewUrl", () => {
  test("gives a bare localhost address the http protocol", () => {
    expect(normalizeViewUrl("localhost:3000")).toBe("http://localhost:3000/");
  });

  test("treats loopback IPs as local", () => {
    expect(normalizeViewUrl("127.0.0.1:5173")).toBe("http://127.0.0.1:5173/");
    expect(normalizeViewUrl("[::1]:5173")).toBe("http://[::1]:5173/");
  });

  test("gives a bare remote host the https protocol", () => {
    expect(normalizeViewUrl("preview.example.com")).toBe(
      "https://preview.example.com/"
    );
  });

  test("keeps an explicit protocol", () => {
    expect(normalizeViewUrl("http://preview.example.com")).toBe(
      "http://preview.example.com/"
    );
  });

  test("canonicalizes case and keeps path and query", () => {
    expect(normalizeViewUrl("HTTP://LOCALHOST:3000/App?x=1")).toBe(
      "http://localhost:3000/App?x=1"
    );
  });

  test("trims surrounding whitespace", () => {
    expect(normalizeViewUrl("  localhost:3000  ")).toBe(
      "http://localhost:3000/"
    );
  });

  test("rejects empty and blank input", () => {
    expect(normalizeViewUrl("")).toBeNull();
    expect(normalizeViewUrl("   ")).toBeNull();
  });

  test("rejects non-http protocols", () => {
    expect(normalizeViewUrl("file:///etc/passwd")).toBeNull();
    expect(normalizeViewUrl("javascript:alert(1)")).toBeNull();
  });

  test("rejects text that is not an address", () => {
    expect(normalizeViewUrl("not a url")).toBeNull();
  });
});

describe("isHttpUrl", () => {
  test("accepts http and https URLs", () => {
    expect(isHttpUrl("http://localhost:3000/")).toBe(true);
    expect(isHttpUrl("https://preview.example.com/app")).toBe(true);
  });

  test("rejects other protocols and non-URLs", () => {
    expect(isHttpUrl("file:///etc/passwd")).toBe(false);
    expect(isHttpUrl("localhost:3000")).toBe(false);
    expect(isHttpUrl("")).toBe(false);
  });
});
