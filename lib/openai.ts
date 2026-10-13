import OpenAI from "openai";
import type { ResponseInputContent } from "openai/resources/responses/responses";
import { config, modelPrice } from "./config";
import { addSpend, usageToday } from "./store";

let client: OpenAI | undefined;
const openai = () => (client ??= new OpenAI());

export class BudgetExceeded extends Error {}

export type ImageInput = { url: string; detail?: "low" | "high" | "auto" };

export interface StructuredCall {
  model: string;
  name: string;
  schema: Record<string, unknown>;
  instructions?: string;
  text: string;
  images?: ImageInput[];
  effort?: "none" | "low" | "medium";
  maxOutputTokens?: number;
}

// One strict-JSON Responses API call. Checks and records the daily spend cap.
export async function structured<T>(call: StructuredCall): Promise<{ data: T; costUsd: number }> {
  const { spendUsd } = await usageToday();
  if (spendUsd >= config.dailyBudgetUsd) {
    throw new BudgetExceeded(`daily OpenAI budget of $${config.dailyBudgetUsd} reached ($${spendUsd.toFixed(2)} spent)`);
  }

  const content: ResponseInputContent[] = [
    { type: "input_text", text: call.text },
    ...(call.images ?? []).map((img) => ({ type: "input_image" as const, image_url: img.url, detail: img.detail ?? "auto" })),
  ];
  const response = await openai().responses.create({
    model: call.model,
    instructions: call.instructions,
    input: [{ role: "user", content }],
    reasoning: { effort: call.effort ?? "low" },
    max_output_tokens: call.maxOutputTokens ?? 4000,
    text: { format: { type: "json_schema", name: call.name, strict: true, schema: call.schema } },
  });

  const [inPrice, outPrice] = modelPrice(call.model);
  const usage = response.usage;
  const costUsd = usage ? (usage.input_tokens * inPrice + usage.output_tokens * outPrice) / 1e6 : 0;
  await addSpend(costUsd);

  if (response.status === "incomplete") throw new Error(`${call.name}: incomplete response (${response.incomplete_details?.reason})`);
  return { data: JSON.parse(response.output_text) as T, costUsd };
}

export interface AgentTool {
  name: string;
  description: string;
  parameters: Record<string, unknown>; // strict JSON schema: every property required, no extras
  run: (args: Record<string, unknown>) => Promise<unknown>;
}

export interface AgentCall {
  tool: string;
  args: Record<string, unknown>;
  result: unknown;
}

// A tool-using loop: the model calls tools until it answers in plain text, runs out of steps, or
// runs out of time. Every step checks and records the daily spend cap, like `structured`.
export async function runAgent(opts: {
  model: string;
  instructions: string;
  input: string;
  tools: AgentTool[];
  maxSteps?: number;
  deadline?: number;
  effort?: "low" | "medium";
}): Promise<{ output: string; calls: AgentCall[]; costUsd: number }> {
  const calls: AgentCall[] = [];
  let costUsd = 0;
  let previous: string | undefined;
  let input: OpenAI.Responses.ResponseInput = [{ role: "user", content: opts.input }];
  const [inPrice, outPrice] = modelPrice(opts.model);

  for (let step = 0; step < (opts.maxSteps ?? 16); step++) {
    const { spendUsd } = await usageToday();
    if (spendUsd >= config.dailyBudgetUsd) throw new BudgetExceeded(`daily OpenAI budget of $${config.dailyBudgetUsd} reached`);
    const outOfTime = opts.deadline != null && Date.now() > opts.deadline;
    const response = await openai().responses.create({
      model: opts.model,
      instructions: opts.instructions,
      input,
      previous_response_id: previous,
      // Out of time: no more tools, so the model has to wrap up in text.
      tools: outOfTime ? [] : opts.tools.map((t) => ({ type: "function" as const, name: t.name, description: t.description, parameters: t.parameters, strict: true })),
      reasoning: { effort: opts.effort ?? "low" },
      max_output_tokens: 6000,
    });
    const cost = response.usage ? (response.usage.input_tokens * inPrice + response.usage.output_tokens * outPrice) / 1e6 : 0;
    costUsd += cost;
    await addSpend(cost);
    previous = response.id;

    const requested = response.output.filter((o): o is OpenAI.Responses.ResponseFunctionToolCall => o.type === "function_call");
    if (!requested.length) return { output: response.output_text.trim(), calls, costUsd };
    input = [];
    for (const call of requested) {
      const tool = opts.tools.find((t) => t.name === call.name);
      const args = JSON.parse(call.arguments || "{}") as Record<string, unknown>;
      let result: unknown;
      try {
        result = tool ? await tool.run(args) : { error: `no tool named ${call.name}` };
      } catch (err) {
        result = { error: (err as Error).message };
      }
      calls.push({ tool: call.name, args, result });
      input.push({ type: "function_call_output", call_id: call.call_id, output: JSON.stringify(result) });
    }
  }
  return { output: "Stopped after the step limit.", calls, costUsd };
}
