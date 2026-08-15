import { COOKIE_NAME } from "@shared/const";
import { TRPCError } from "@trpc/server";
import { z } from "zod";
import { getSessionCookieOptions } from "./_core/cookies";
import { systemRouter } from "./_core/systemRouter";
import { protectedProcedure, publicProcedure, router } from "./_core/trpc";
import { createPromptAsset, listOwnedPromptAssets, listPromptAssets, removePromptAsset } from "./db";
import { buildReferenceContext, createReferencePreview, DEFAULT_REFERENCE_TOKENS, estimateReferenceTokens, extractReferenceText, findReferenceSearchMatches, MAX_REFERENCE_FILES, MAX_REFERENCE_TOKENS_PER_FILE, MAX_REFERENCE_TOKENS_TOTAL, MIN_REFERENCE_TOKENS, sourceCitation } from "./referenceContext";
import { storageGetSignedUrl, storagePut } from "./storage";
import { createHostedProviderGateway, HostedProviderError } from "./hostedProviders";

const MAX_UPLOAD_BYTES = 2 * 1024 * 1024;
const ALLOWED_TYPES = ["text/plain", "text/markdown", "application/pdf"] as const;
const hostedGateway = createHostedProviderGateway();

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

const referenceSelectionSchema = z.object({
  assetId: z.number().int().positive(),
  tokenBudget: z.number().int().min(MIN_REFERENCE_TOKENS).max(MAX_REFERENCE_TOKENS_PER_FILE),
});

async function resolveReferenceSelection(userId: number, selection: Array<z.infer<typeof referenceSelectionSchema>>) {
  const ids = selection.map((source) => source.assetId);
  const assets = await listOwnedPromptAssets(userId, ids);
  if (assets.length !== ids.length) {
    throw new TRPCError({ code: "NOT_FOUND", message: "One or more selected references are unavailable in this workspace." });
  }
  const byId = new Map(assets.map((asset) => [asset.id, asset]));
  return Promise.all(selection.map(async (source, index) => {
    const asset = byId.get(source.assetId);
    if (!asset) throw new TRPCError({ code: "NOT_FOUND", message: "Selected reference not found." });
    const signedUrl = await storageGetSignedUrl(asset.storageKey);
    const response = await fetch(signedUrl);
    if (!response.ok) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: `Could not read ${asset.originalName}.` });
    const text = await extractReferenceText({ originalName: asset.originalName, contentType: asset.contentType, bytes: new Uint8Array(await response.arrayBuffer()) });
    return {
      id: asset.id,
      originalName: asset.originalName,
      text,
      tokenBudget: source.tokenBudget,
      citation: sourceCitation(index),
      estimatedTokens: estimateReferenceTokens(text),
      preview: createReferencePreview(text),
    };
  }));
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
  hosted: router({
    capabilities: protectedProcedure.query(() => hostedGateway.capabilities()),
    generate: protectedProcedure
      .input(z.object({
        provider: z.enum(["openai", "anthropic", "gemini", "compatible"]),
        model: z.string().trim().min(1).max(120),
        system: z.string().min(1).max(48_000),
        user: z.string().min(1).max(48_000),
        temperature: z.number().min(0).max(1).default(0.2),
      }))
      .mutation(async ({ ctx, input }) => {
        try {
          return await hostedGateway.generate({ ...input, userId: ctx.user.id });
        } catch (error) {
          if (error instanceof HostedProviderError) {
            throw new TRPCError({ code: error.kind === "rate_limit" ? "TOO_MANY_REQUESTS" : error.kind === "configuration" ? "PRECONDITION_FAILED" : "BAD_GATEWAY", message: error.message });
          }
          throw error;
        }
      }),
  }),
  assets: router({
    list: protectedProcedure.query(({ ctx }) => listPromptAssets(ctx.user.id)),
    search: protectedProcedure
      .input(z.object({ assetIds: z.array(z.number().int().positive()).min(1).max(MAX_REFERENCE_FILES).refine((ids) => new Set(ids).size === ids.length, "Each reference may be searched only once."), query: z.string().trim().min(2).max(100) }))
      .mutation(async ({ ctx, input }) => {
        const sources = await resolveReferenceSelection(ctx.user.id, input.assetIds.map((assetId) => ({ assetId, tokenBudget: DEFAULT_REFERENCE_TOKENS })));
        const results = sources.map(({ id, originalName, text }) => ({ id, originalName, matches: findReferenceSearchMatches(text, input.query) })).filter((result) => result.matches.length > 0);
        return { query: input.query, results, totalMatches: results.reduce((total, result) => total + result.matches.length, 0) };
      }),
    previewContext: protectedProcedure
      .input(z.object({ sources: z.array(referenceSelectionSchema).min(1).max(MAX_REFERENCE_FILES).refine((sources) => new Set(sources.map((source) => source.assetId)).size === sources.length, "Each reference may be selected only once.").refine((sources) => sources.reduce((total, source) => total + source.tokenBudget, 0) <= MAX_REFERENCE_TOKENS_TOTAL, `The combined reference budget may not exceed ${MAX_REFERENCE_TOKENS_TOTAL} tokens.`) }))
      .mutation(async ({ ctx, input }) => {
        const sources = await resolveReferenceSelection(ctx.user.id, input.sources);
        return { sources, totalBudget: input.sources.reduce((total, source) => total + source.tokenBudget, 0) };
      }),
    compileContext: protectedProcedure
      .input(z.object({ sources: z.array(referenceSelectionSchema).min(1).max(MAX_REFERENCE_FILES).refine((sources) => new Set(sources.map((source) => source.assetId)).size === sources.length, "Each reference may be selected only once.").refine((sources) => sources.reduce((total, source) => total + source.tokenBudget, 0) <= MAX_REFERENCE_TOKENS_TOTAL, `The combined reference budget may not exceed ${MAX_REFERENCE_TOKENS_TOTAL} tokens.`) }))
      .mutation(async ({ ctx, input }) => {
        const sources = await resolveReferenceSelection(ctx.user.id, input.sources);
        const context = buildReferenceContext(sources);
        if (!context) throw new TRPCError({ code: "BAD_REQUEST", message: "Selected sources did not contain readable text." });
        return { context, sources: sources.map(({ id, originalName, citation, tokenBudget, estimatedTokens }) => ({ id, originalName, citation, tokenBudget, estimatedTokens })) };
      }),
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
