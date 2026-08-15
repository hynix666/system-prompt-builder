import { describe, expect, it } from "vitest";
import { localRetryBackoffSeconds, MAX_LOCAL_RELOAD_RETRIES } from "./localRetry";

describe("local retry backoff", () => {
  it("uses bounded exponential retry delays", () => {
    expect(MAX_LOCAL_RELOAD_RETRIES).toBe(3);
    expect(localRetryBackoffSeconds(1)).toBe(1);
    expect(localRetryBackoffSeconds(2)).toBe(2);
    expect(localRetryBackoffSeconds(3)).toBe(4);
  });

  it("rejects attempts outside the retry limit", () => {
    expect(localRetryBackoffSeconds(0)).toBeNull();
    expect(localRetryBackoffSeconds(4)).toBeNull();
  });
});
