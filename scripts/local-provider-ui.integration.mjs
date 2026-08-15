import http from "node:http";
import { chromium } from "playwright-core";

const APP_URL = process.env.LOCAL_PROVIDER_UI_APP_URL ?? "http://127.0.0.1:3000";
const HEALTH_PORT = 43123;
const CORS_PORT = 43124;

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

  const browser = await chromium.launch({ executablePath: "/usr/bin/chromium", headless: true, args: ["--no-sandbox"] });
  const page = await browser.newPage();

  try {
    await page.goto(APP_URL, { waitUntil: "networkidle" });
    await page.getByRole("radio", { name: "OLLAMA" }).click();
    await page.getByLabel("LOCAL ENDPOINT").fill(`http://127.0.0.1:${HEALTH_PORT}/v1`);
    await page.getByRole("combobox", { name: "MODEL" }).fill("signal-ledger-local");

    await page.getByRole("button", { name: "CHECK LOCAL SERVER" }).click();
    await page.getByText(/LOCAL HEALTH:/).waitFor();
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

    await page.screenshot({ path: "/home/ubuntu/local-provider-ui.integration.png", fullPage: true });
    console.log("Local provider UI integration: passed (health latency, discovery, generation, CORS guide).");
  } finally {
    await browser.close();
    await new Promise((resolve) => healthyServer.close(resolve));
    await new Promise((resolve) => corsServer.close(resolve));
  }
}

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
