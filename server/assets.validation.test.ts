import { describe, expect, it } from "vitest";
import { appRouter } from "./routers";
import type { TrpcContext } from "./_core/context";

function authenticatedContext(): TrpcContext {
  return {
    user: {
      id: 42,
      openId: "storage-test-user",
      name: "Storage Test",
      email: null,
      loginMethod: "manus",
      role: "user",
      createdAt: new Date(),
      updatedAt: new Date(),
      lastSignedIn: new Date(),
    },
    req: { protocol: "https", headers: {} } as TrpcContext["req"],
    res: {} as TrpcContext["res"],
  };
}

describe("assets validation", () => {
  it("rejects unsupported media types before contacting storage", async () => {
    const caller = appRouter.createCaller(authenticatedContext());
    await expect(caller.assets.upload({
      originalName: "untrusted.exe",
      contentType: "application/octet-stream" as "text/plain",
      base64: "YQ==",
    })).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });

  it("rejects invalid removal identifiers before contacting the database", async () => {
    const caller = appRouter.createCaller(authenticatedContext());
    await expect(caller.assets.remove({ id: 0 })).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });
});
