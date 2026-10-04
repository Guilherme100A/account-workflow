import { describe, expect, it, vi } from "vitest";
const launch = vi.hoisted(() => vi.fn());
vi.mock("cloakbrowser", () => ({ launch }));
import { proxyFromEnvironment } from "../src/core/proxy.js";
import { openSession } from "../src/core/browser.js";

describe("proxy pool configuration", () => {
  it("preserves direct mode when unconfigured", () => {
    expect(proxyFromEnvironment({})).toBeUndefined();
  });
  it("separates URL credentials and supports environment overrides", () => {
    expect(proxyFromEnvironment({ WORKFLOW_PROXY_SERVER: "http://user:p%40ss@pool.test:8080" }))
      .toEqual({ server: "http://pool.test:8080", username: "user", password: "p@ss" });
    expect(proxyFromEnvironment({ WORKFLOW_PROXY_SERVER: "http://old.test:80", WORKFLOW_PROXY_USERNAME: "account", WORKFLOW_PROXY_PASSWORD: "secret" }, "http://pool.test:8080"))
      .toEqual({ server: "http://pool.test:8080", username: "account", password: "secret" });
  });
  it.each(["garbage", "ftp://pool.test", "http://pool.test/path", "http://pool.test?secret=1", "socks5://user:pass@pool.test:1080"])("rejects invalid or unsupported proxy %s", server => {
    expect(() => proxyFromEnvironment({ WORKFLOW_PROXY_SERVER: server })).toThrow();
  });
  it("rejects credentials without a gateway", () => {
    expect(() => proxyFromEnvironment({ WORKFLOW_PROXY_PASSWORD: "secret" })).toThrow();
  });
  it("passes proxy to each browser launch and propagates failure", async () => {
    const context = { newPage: vi.fn().mockResolvedValue({}), close: vi.fn() };
    launch.mockResolvedValue({ newContext: vi.fn().mockResolvedValue(context), close: vi.fn() });
    const proxy = { server: "http://pool.test:8080", username: "account", password: "secret" };
    await openSession({ proxy });
    await openSession({ proxy });
    expect(launch).toHaveBeenLastCalledWith(expect.objectContaining({ proxy }));
    expect(launch).toHaveBeenCalledTimes(2);
    launch.mockRejectedValueOnce(new Error("Proxy connection failed"));
    await expect(openSession({ proxy })).rejects.toThrow("Proxy connection failed");
    expect(launch).toHaveBeenCalledTimes(3);
  });
});
