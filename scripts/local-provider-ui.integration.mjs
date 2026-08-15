import http from "node:http";
import { readFile } from "node:fs/promises";
import { chromium } from "playwright-core";

const APP_URL = process.env.LOCAL_PROVIDER_UI_APP_URL ?? "http://127.0.0.1:3000";
const HEALTH_PORT = 43123;
const CORS_PORT = 43124;
const LM_PORT = 43125;

function pause(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function json(response, body, { cors = false } = {}) {
  response.writeHead(200, {
    "Content-Type": "application/json",
    ...(cors ? { "Access-Control-Allow-Origin": "*" } : {}),
  });
  response.end(JSON.stringify(body));
}

function startServer(port, handler) {
  return new Promise((resolve) => {
    const server = http.createServer(handler);
    server.listen(port, "127.0.0.1", () => resolve(server));
  });
}

async function run() {
  const healthyServer = await startServer(HEALTH_PORT, async (request, response) => {
    if (request.method === "OPTIONS") {
      response.writeHead(204, {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type",
      });
      response.end();
      return;
    }
    if (request.url === "/api/ps") return json(response, { models: [{ name: "signal-ledger-local", size: 4_294_967_296, size_vram: 2_147_483_648, details: { quantization_level: "Q4_K_M" } }] }, { cors: true });
    if (request.url === "/v1/models") {
      await pause(55);
      return json(response, { data: [{ id: "signal-ledger-local" }] }, { cors: true });
    }
    if (request.url === "/v1/chat/completions" && request.method === "POST") {
      return json(response, {
        choices: [{ message: { content: "Controlled local stage output" }, finish_reason: "stop" }],
        usage: { prompt_tokens: 12, completion_tokens: 4, total_tokens: 16 },
      }, { cors: true });
    }
    response.writeHead(404, { "Access-Control-Allow-Origin": "*" });
    response.end();
  });

  const corsServer = await startServer(CORS_PORT, (request, response) => {
    if (request.url === "/v1/models") return json(response, { data: [{ id: "unreachable-in-browser" }] });
    response.writeHead(404);
    response.end();
  });

  let lmGenerationCalls = 0;
  const lmServer = await startServer(LM_PORT, async (request, response) => {
    if (request.method === "OPTIONS") {
      response.writeHead(204, {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type",
      });
      response.end();
      return;
    }
    if (request.url === "/api/v0/models") return json(response, { data: [{ id: "lm-studio-local", state: "loaded", size: 3_221_225_472, gpu_memory_bytes: 1_610_612_736, offload_kv_cache_to_gpu: true, quantization: "Q4_K_M" }] }, { cors: true });
    if (request.url === "/v1/models") return json(response, { data: [{ id: "lm-studio-local" }] }, { cors: true });
    if (request.url === "/v1/chat/completions" && request.method === "POST") {
      lmGenerationCalls += 1;
      if (lmGenerationCalls === 1) return json(response, { error: { code: "model_not_loaded", message: "model not loaded in memory" } }, { cors: true });
      return json(response, { choices: [{ message: { content: "LM Studio retry output" }, finish_reason: "stop" }] }, { cors: true });
    }
    response.writeHead(404, { "Access-Control-Allow-Origin": "*" });
    response.end();
  });

  const browser = await chromium.launch({ executablePath: "/usr/bin/chromium", headless: true, args: ["--no-sandbox"] });
  const page = await browser.newPage();

  try {
    await page.goto(APP_URL, { waitUntil: "networkidle" });
    await page.getByRole("radio", { name: "OLLAMA" }).click();
    await page.getByLabel("LOCAL ENDPOINT").fill(`http://127.0.0.1:${HEALTH_PORT}/v1`);
    await page.getByRole("combobox", { name: "MODEL" }).fill("signal-ledger-local");

    await page.getByRole("button", { name: "CHECK LOCAL SERVER" }).click();
    await page.getByText(/LOCAL HEALTH:/).waitFor();
    await page.getByText("MODEL LOADED").waitFor();
    const healthText = await page.getByText(/LOCAL HEALTH:/).textContent();
    if (!healthText?.includes("Response:") || !/Response: [1-9]\d* ms\./.test(healthText)) {
      throw new Error(`Expected a positive latency display, received: ${healthText}`);
    }

    await page.getByRole("button", { name: "DISCOVER LOCAL MODELS" }).click();
    await page.waitForTimeout(600);
    const providerPanelText = await page.locator(".sl-provider-fields").innerText();
    if (!/1 local model available\.|Model discovery is ready\./.test(providerPanelText)) {
      throw new Error(`Expected local model discovery notice. Provider panel: ${providerPanelText}`);
    }

    const generationResponse = page.waitForResponse((response) => response.url() === `http://127.0.0.1:${HEALTH_PORT}/v1/chat/completions` && response.request().method() === "POST", { timeout: 5_000 });
    await page.getByRole("button", { name: "RUN THIS" }).click();
    await generationResponse;
    await page.waitForTimeout(500);
    const renderedText = await page.locator("body").innerText();
    if (!renderedText.includes("Controlled local stage output")) {
      throw new Error(`Expected the generated local stage output. Rendered page text: ${renderedText.slice(0, 1800)}`);
    }

    await page.getByLabel("LOCAL ENDPOINT").fill(`http://127.0.0.1:${CORS_PORT}/v1`);
    await page.getByRole("button", { name: "CHECK LOCAL SERVER" }).click();
    await page.getByText("CORS TROUBLESHOOTING:").waitFor();
    await page.getByText(/Ollama browser access — setup guide/).click();
    await page.getByText(/OLLAMA_ORIGINS=/).waitFor();

    await page.reload({ waitUntil: "networkidle" });
    await page.getByRole("radio", { name: "LM STUDIO" }).click();
    await page.getByLabel("LOCAL ENDPOINT").fill(`http://127.0.0.1:${LM_PORT}/v1`);
    await page.getByRole("combobox", { name: "MODEL" }).fill("lm-studio-local");
    await page.getByRole("button", { name: "CHECK LOCAL SERVER" }).click();
    await page.getByText(/LOCAL HEALTH:/).waitFor();
    await page.getByText("MODEL LOADED").waitFor();
    const firstLmResponse = page.waitForResponse((response) => response.url() === `http://127.0.0.1:${LM_PORT}/v1/chat/completions` && response.request().method() === "POST", { timeout: 5_000 });
    await page.getByRole("button", { name: "RUN THIS" }).click();
    await firstLmResponse;
    await page.getByText("MODEL UNLOADED").waitFor();
    await page.getByRole("button", { name: "SHOW RELOAD STEPS" }).click();
    await page.getByText("RETRY IN 1s").waitFor();
    await page.getByRole("button", { name: "RETRY IN 1s" }).click();
    await page.getByText("RETRY SCHEDULED").waitFor();
    await page.waitForTimeout(1_600);
    const retryText = await page.locator("body").innerText();
    if (!retryText.includes("LM Studio retry output") || !retryText.includes("Retry succeeded after the local model reload.")) {
      throw new Error(`Expected LM Studio retry success. Rendered page text: ${retryText.slice(0, 1800)}`);
    }

    await page.getByRole("button", { name: "SUPPORT LOG" }).click();
    await page.getByRole("dialog", { name: "Diagnostic preview" }).waitFor();
    await page.getByText("promptContent").waitFor();
    const diagnosticDownload = page.waitForEvent("download", { timeout: 5_000 });
    await page.getByRole("button", { name: "DOWNLOAD REDACTED LOG" }).click();
    const diagnosticFile = await diagnosticDownload;
    const diagnosticPath = await diagnosticFile.path();
    if (!diagnosticPath) throw new Error("Expected a redacted diagnostic download path.");
    const diagnosticText = await readFile(diagnosticPath, "utf8");
    if (!diagnosticText.includes('"promptContent": "excluded"') || diagnosticText.includes("system prompt")) {
      throw new Error(`Diagnostic export was not redacted as expected: ${diagnosticText.slice(0, 1400)}`);
    }

    await page.screenshot({ path: "/home/ubuntu/local-provider-ui.integration.png", fullPage: true });
    console.log("Local provider UI integration: passed (Ollama latency/discovery/generation/CORS guide and LM Studio reload retry).");
  } finally {
    await browser.close();
    await new Promise((resolve) => healthyServer.close(resolve));
    await new Promise((resolve) => corsServer.close(resolve));
    await new Promise((resolve) => lmServer.close(resolve));
  }
}

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
