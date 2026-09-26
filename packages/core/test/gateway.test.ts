import { expect, test } from "bun:test";
import { jevEndpoint } from "../src/config";
import { gatewayBackend } from "../src/brains/chat";
import { collect, fakeIO, openAiSse } from "./brains.fakes";

const env = (m: Record<string, string>) => (n: string) => m[n] ?? "";

test("jev: AI Gateway first, TypeSafe direct second, local otherwise", () => {
  expect(jevEndpoint(env({ AI_GATEWAY_API_KEY: "gw", TYPESAFE_API_KEY: "ts" }))).toEqual({
    url: "https://ai-gateway.vercel.sh/v1/evaluate",
    model: "typesafe-ai/jev",
    apiKey: "gw",
    via: "gateway",
  });
  expect(jevEndpoint(env({ TYPESAFE_API_KEY: "ts" }))?.url).toBe("https://api.typesafe.ai/v1/systemone");
  expect(jevEndpoint(env({ TYPESAFE_API_KEY: "ts" }))?.model).toBe("jev-latest");
  expect(jevEndpoint(env({}))).toBeNull();
});

test("gateway persona: openai-compatible chat with a provider/model id, falls through missing models", async () => {
  const bodies: any[] = [];
  const io = fakeIO({
    secrets: { AI_GATEWAY_API_KEY: "gw" },
    fetch: async (url: string, init?: RequestInit) => {
      expect(url).toBe("https://ai-gateway.vercel.sh/v1/chat/completions");
      expect(String((init!.headers as Record<string, string>).Authorization)).toBe("Bearer gw");
      const b = JSON.parse(String(init!.body));
      bodies.push(b);
      if (b.model === "anthropic/claude-haiku-4.5") return new Response('{"error":"model not found"}', { status: 404 });
      return openAiSse(["twenty-one ", "bucks."]);
    },
  } as never);
  const b = gatewayBackend(io);
  expect(b.configured()).toBe(true);
  const out = (await collect(b.stream({ system: "s", user: "u" }, { maxTokens: 40 }))).join("");
  expect(out).toBe("twenty-one bucks.");
  expect(bodies.map((x) => x.model)).toEqual(["anthropic/claude-haiku-4.5", "openai/gpt-6-luna-fast"]);
  // gpt-6 gets reasoning off and max_completion_tokens
  expect(bodies[1].reasoning_effort).toBe("none");
  expect(bodies[1].max_completion_tokens).toBe(40);
  // sticks with the model that worked
  expect(b.model()).toBe("openai/gpt-6-luna-fast");
});
