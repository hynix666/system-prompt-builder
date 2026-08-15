# Hosted Provider Integration Requirements

This delivered project is intentionally **frontend-only**. It does not accept or transmit Anthropic, OpenAI, or Gemini credentials from the browser. The shipped user interface exposes only the offline demonstration and explicitly configured `localhost` endpoints for Ollama or LM Studio.

To enable a hosted provider, upgrade the project to a backend-capable architecture and implement an authenticated server-side adapter. The adapter should accept a normalized request containing the selected approved provider, model identifier, system instruction, and user instruction. It should then retrieve the provider credential only from server-side secret storage, attach the provider-required headers, enforce a strict model allowlist and request-size limit, apply per-user rate controls, normalize provider errors, and return only the required response text, usage metadata, and finish reason.

The browser must not receive a persistent provider API key. A hosted adapter should also ensure that model discovery is server-mediated, that request tracing omits raw prompt content by default, and that a configured provider cannot be selected until the adapter reports ready.

## Adapter contract

| Endpoint | Method | Request | Response |
|---|---|---|---|
| `/api/prompt-builder/generate` | `POST` | `{ provider, model, system, user, temperature? }` | `{ text, usage?: { inputTokens, outputTokens, totalTokens }, finishReason? }` |
| `/api/prompt-builder/models` | `GET` | `?provider=anthropic|openai|gemini` | `{ models: string[] }` |

The server must reject arbitrary endpoint URLs, arbitrary headers, unsupported providers/models, and payloads beyond the deployment’s documented limit. It should use provider-specific SDKs or HTTP clients that conform to each provider’s documented authentication and versioning requirements.

## Static-build behavior

The current client validates that local endpoints use `localhost`, `127.0.0.1`, or `[::1]` with `http` or `https`. This keeps local development deliberate and prevents an accidental browser-side proxy to a remote provider.
