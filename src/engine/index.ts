import Anthropic from "@anthropic-ai/sdk";
import { getConfig } from "../config";
import { createChildLogger } from "../logger";
import { SYSTEM_PROMPT, buildUserPrompt } from "./prompt";
import type { CollectedContext, DecisionResult, Decision } from "../types";

const log = createChildLogger("engine");

let _client: Anthropic | null = null;

function getClient(): Anthropic {
  if (!_client) {
    const config = getConfig();
    _client = new Anthropic({ apiKey: config.ANTHROPIC_API_KEY });
  }
  return _client;
}

// ── Claude tool definition for structured response ───────────────

const EVALUATE_TOOL: Anthropic.Tool = {
  name: "evaluate_checkin",
  description:
    "Evaluate the current check-in data and return a structured decision about whether to notify the user.",
  input_schema: {
    type: "object" as const,
    properties: {
      decision: {
        type: "string",
        enum: ["NONE", "TEXT", "CALL"],
        description:
          "NONE = no notification needed, TEXT = send Telegram message, CALL = trigger voice call",
      },
      urgency: {
        type: "number",
        minimum: 1,
        maximum: 10,
        description: "Urgency level from 1 (routine) to 10 (critical)",
      },
      summary: {
        type: "string",
        description:
          "Concise notification text for the user (under 300 chars for TEXT, 500 for CALL). Only shown if decision is TEXT or CALL.",
      },
      reasoning: {
        type: "string",
        description:
          "Internal reasoning for why this decision was made. Not shown to user — used for logging and debugging.",
      },
      actionButtons: {
        type: "array",
        items: { type: "string" },
        description:
          'Action button identifiers for Telegram inline keyboard. Format: "action_type:id" (e.g., "snooze_email:abc123", "snooze_all")',
      },
      spokenBriefing: {
        type: "string",
        description:
          "Natural-language briefing for voice call (only for CALL decisions). Written to be spoken aloud — no markdown, no special chars.",
      },
    },
    required: ["decision", "urgency", "summary", "reasoning", "actionButtons"],
  },
};

// ── Main decision function ────────────────────────────────────────

export async function makeDecision(
  context: CollectedContext
): Promise<DecisionResult> {
  // Config is loaded (validates ANTHROPIC_API_KEY exists)
  getConfig();

  log.info(
    {
      emails: context.emails.length,
      events: context.calendar.length,
      tasks: context.tasks.length,
    },
    "Decision engine invoked"
  );

  // Build the prompt with all collected context
  const userPrompt = buildUserPrompt(context);

  log.debug(
    { promptLength: userPrompt.length },
    "Built user prompt for Claude"
  );

  try {
    const client = getClient();

    const response = await client.messages.create({
      model: "claude-sonnet-4-20250514",
      max_tokens: 1024,
      system: SYSTEM_PROMPT,
      tools: [EVALUATE_TOOL],
      tool_choice: { type: "tool", name: "evaluate_checkin" },
      messages: [{ role: "user", content: userPrompt }],
    });

    // Extract the tool use result
    const toolUse = response.content.find(
      (block) => block.type === "tool_use"
    );

    if (!toolUse || toolUse.type !== "tool_use") {
      log.error(
        { response: JSON.stringify(response.content) },
        "Claude did not return a tool_use block"
      );
      return fallbackDecision("Claude did not return structured response");
    }

    const input = toolUse.input as {
      decision: string;
      urgency: number;
      summary: string;
      reasoning: string;
      actionButtons: string[];
      spokenBriefing?: string;
    };

    // Validate the decision value
    const validDecisions: Decision[] = ["NONE", "TEXT", "CALL"];
    if (!validDecisions.includes(input.decision as Decision)) {
      log.error({ decision: input.decision }, "Invalid decision from Claude");
      return fallbackDecision(`Invalid decision: ${input.decision}`);
    }

    // Clamp urgency to 1-10
    const urgency = Math.max(1, Math.min(10, Math.round(input.urgency)));

    const result: DecisionResult = {
      decision: input.decision as Decision,
      urgency,
      summary: input.summary,
      reasoning: input.reasoning,
      actionButtons: input.actionButtons || [],
      spokenBriefing: input.spokenBriefing,
    };

    log.info(
      {
        decision: result.decision,
        urgency: result.urgency,
        reasoning: result.reasoning,
        buttonCount: result.actionButtons.length,
      },
      "Claude decision received"
    );

    // Log token usage
    log.debug(
      {
        inputTokens: response.usage.input_tokens,
        outputTokens: response.usage.output_tokens,
      },
      "Claude API usage"
    );

    return result;
  } catch (error) {
    log.error({ error }, "Claude API call failed");
    return fallbackDecision(`API error: ${(error as Error).message}`);
  }
}

// ── Fallback when Claude fails ───────────────────────────────────

function fallbackDecision(reason: string): DecisionResult {
  log.warn({ reason }, "Using fallback decision");
  return {
    decision: "NONE",
    urgency: 0,
    summary: `Decision engine error: ${reason}`,
    reasoning: `Fallback due to error: ${reason}`,
    actionButtons: [],
  };
}
