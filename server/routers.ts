import { COOKIE_NAME } from "@shared/const";
import { TRPCError } from "@trpc/server";
import { z } from "zod";
import { getSessionCookieOptions } from "./_core/cookies";
import { systemRouter } from "./_core/systemRouter";
import { protectedProcedure, publicProcedure, router } from "./_core/trpc";
import { createPromptAsset, listPromptAssets, removePromptAsset } from "./db";
import { storagePut } from "./storage";

const MAX_UPLOAD_BYTES = 2 * 1024 * 1024;
const ALLOWED_TYPES = ["text/plain", "text/markdown", "application/pdf"] as const;

function safeFileName(name: string) {
  const normalized = name.normalize("NFKD").replace(/[\u0300-\u036f]/g, "");
  const cleaned = normalized.replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 140);
  return cleaned || "prompt-reference";
}

function decodeUpload(base64: string) {
  const bytes = Buffer.from(base64, "base64");
  if (!bytes.length || bytes.length > MAX_UPLOAD_BYTES) {
    throw new TRPCError({ code: "PAYLOAD_TOO_LARGE", message: "Files must be between 1 byte and 2 MB." });
  }
  return bytes;
}

export const appRouter = router({
    // if you need to use socket.io, read and register route in server/_core/index.ts, all api should start with '/api/' so that the gateway can route correctly
  system: systemRouter,
  auth: router({
    me: publicProcedure.query(opts => opts.ctx.user),
    logout: publicProcedure.mutation(({ ctx }) => {
      const cookieOptions = getSessionCookieOptions(ctx.req);
      ctx.res.clearCookie(COOKIE_NAME, { ...cookieOptions, maxAge: -1 });
      return {
        success: true,
      } as const;
    }),
  }),
  assets: router({
    list: protectedProcedure.query(({ ctx }) => listPromptAssets(ctx.user.id)),
    upload: protectedProcedure
      .input(z.object({
        originalName: z.string().trim().min(1).max(255),
        contentType: z.enum(ALLOWED_TYPES),
        base64: z.string().min(1).max(2_800_000),
      }))
      .mutation(async ({ ctx, input }) => {
        const bytes = decodeUpload(input.base64);
        const originalName = safeFileName(input.originalName);
        const { key, url } = await storagePut(`prompt-assets/${ctx.user.id}/${originalName}`, bytes, input.contentType);
        return createPromptAsset({
          userId: ctx.user.id,
          storageKey: key,
          url,
          originalName,
          contentType: input.contentType,
          byteSize: bytes.byteLength,
        });
      }),
    remove: protectedProcedure
      .input(z.object({ id: z.number().int().positive() }))
      .mutation(async ({ ctx, input }) => {
        const removed = await removePromptAsset(input.id, ctx.user.id);
        if (!removed) throw new TRPCError({ code: "NOT_FOUND", message: "This reference file no longer exists." });
        return { success: true } as const;
      }),
  }),
});

export type AppRouter = typeof appRouter;
