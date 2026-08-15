/**
 * The brain — the thing that turns a briefing into proposed directives.
 *
 * Two implementations share one interface: the real model (`createLlmBrain`,
 * `claude-opus-5` with structured outputs) and a deterministic heuristic
 * (`heuristic.ts`) that lets the whole simulation run with no API key at all.
 * The engine never sees which one spoke — it only ever adjudicates directives.
 */

import Anthropic from "@anthropic-ai/sdk";
import type { Briefing } from "./briefing.ts";
import { type DirectiveSet, DIRECTIVE_OUTPUT_SCHEMA, parseDirectiveSet } from "./directives.ts";
import type { Civ, World } from "@sim/engine";

export interface DecisionContext {
  world: World;
  civ: Civ;
  briefing: Briefing;
}

export interface Brain {
  /** "llm" or "heuristic" — for logging and tests. */
  readonly kind: string;
  /** Propose (never enact) a set of directives for this civ's decision. */
  decide(ctx: DecisionContext): Promise<DirectiveSet>;
}

/** What one model call consumed — the hook the attention budget meters by.
 *  Token counts come straight from the API's usage block. */
export interface BrainUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  stopReason: string | null;
}

export interface LlmBrainOptions {
  apiKey?: string;
  model?: string;
  maxTokens?: number;
  /** Called after every completed model call with its usage. This is how the
   *  runner's attention budget sees real spend without the brain knowing any
   *  budget exists — the brain proposes, the budget meters. */
  onUsage?: (usage: BrainUsage) => void;
}

/** The model as the constraints require it: `claude-opus-5`, structured output
 *  via `output_config.format`, adaptive thinking left on (no `budget_tokens`,
 *  `temperature`, `top_p` or `top_k`), and `stop_reason:"refusal"` handled
 *  before any content is read. The stable briefing prefix carries the cache
 *  breakpoints, so cost stays flat across a long run. */
export function createLlmBrain(opts: LlmBrainOptions = {}): Brain {
  const client = new Anthropic({ apiKey: opts.apiKey ?? process.env.ANTHROPIC_API_KEY });
  const model = opts.model ?? "claude-opus-5";
  const max_tokens = opts.maxTokens ?? 2048;

  return {
    kind: "llm",
    async decide({ briefing }: DecisionContext): Promise<DirectiveSet> {
      const message = await client.messages.create({
        model,
        max_tokens,
        system: briefing.system,
        messages: [{ role: "user", content: briefing.context }],
        output_config: {
          format: { type: "json_schema", schema: DIRECTIVE_OUTPUT_SCHEMA as Record<string, unknown> },
        },
      });

      opts.onUsage?.({
        inputTokens: message.usage.input_tokens,
        outputTokens: message.usage.output_tokens,
        cacheReadTokens: message.usage.cache_read_input_tokens ?? 0,
        cacheCreationTokens: message.usage.cache_creation_input_tokens ?? 0,
        stopReason: message.stop_reason,
      });

      // A streaming classifier can intervene; handle that before touching content.
      if (message.stop_reason === "refusal") return { directives: [] };

      let text = "";
      for (const block of message.content) {
        if (block.type === "text") text += block.text;
      }
      return parseDirectiveSet(text);
    },
  };
}
