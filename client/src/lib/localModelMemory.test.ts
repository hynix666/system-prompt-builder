import { describe, expect, it } from "vitest";
import { parseLocalModelMemory, rememberLocalModel } from "./localModelMemory";

describe("local model memory", () => {
  it("parses only valid named model values for each local provider", () => {
    expect(parseLocalModelMemory('{"ollama":"qwen3:8b","lmstudio":42}')).toEqual({ ollama: "qwen3:8b", lmstudio: "" });
    expect(parseLocalModelMemory("not json")).toEqual({ ollama: "", lmstudio: "" });
  });

  it("records a successful model independently for each provider", () => {
    const initial = { ollama: "", lmstudio: "" };
    const afterOllama = rememberLocalModel(initial, "ollama", " qwen3:8b ");
    expect(afterOllama).toEqual({ ollama: "qwen3:8b", lmstudio: "" });
    expect(rememberLocalModel(afterOllama, "lmstudio", "mistral-7b")).toEqual({ ollama: "qwen3:8b", lmstudio: "mistral-7b" });
  });
});
