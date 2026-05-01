import { ChatOpenAI } from "@langchain/openai";
import { z } from "zod";

const classificationSchema = z.object({
  classification: z.enum(["GREET", "KONGR", "OFFT"]).describe("GREET for Greetings, KONGR for Technical Kong Related, OFFT for Off Topic")
});

export class PromptAnalyser {
  /**
   * Analyzes if a user prompt is a greeting, a technical query, or off-topic.
   * Returns 'GREET', 'KONGR', or 'OFFT', along with token usage.
   */
  static async classify(prompt: string, model: ChatOpenAI, signal?: AbortSignal): Promise<{ classification: 'GREET' | 'KONGR' | 'OFFT', usage?: { inputTokens: number, outputTokens: number } }> {
    try {
      const structuredModel = model.withStructuredOutput(classificationSchema, { includeRaw: true });
      
      const systemPrompt = "You are a query classifier for a Kong Gateway specialist agent.\n\n" +
                           "CATEGORIES:\n" +
                           "- GREET: Common greetings (e.g. 'hi', 'hello', 'hey', 'good morning'), simple pleasantries ('how are you doing?'), and isolated affirmations/denials (e.g., 'Yes', 'No', 'Proceed', 'Approve', 'Cancel' when NOT followed by a command).\n" +
                           "- KONGR: TECHNICAL queries about Kong Gateway, status checks, Docker, decK (e.g., 'ruleset.yaml', 'kong-deck-state.yml'), GitOps, API management, or local config files (e.g., 'kong.conf'). Also includes requests to review, summarize, lint, or validate changes to these files.\n" +
                           "- OFFT: Jokes, humor, poetry, general trivia, world events, or extensive small talk. \n\n" +
                           "CRITICAL RULE: Technical questions and requests to review Kong files MUST be KONGR even if they seem generic. Greetings/Pleasantries are strictly GREET.\n\n" +
                           "EXAMPLES:\n" +
                           "- User: 'How do I add a service?' -> KONGR\n" +
                           "- User: 'is kong running?' -> KONGR\n" +
                           "- User: 'I have accepted changes to ruleset.yaml. Review them.' -> KONGR\n" +
                           "- User: 'Hi' -> GREET\n" +
                           "- User: 'Yes' -> GREET\n" +
                           "- User: 'Tell me a joke.' -> OFFT\n" +
                           "- User: 'Review my kong.conf changes' -> KONGR\n";

      const result = await structuredModel.invoke([
        { role: "system", content: systemPrompt },
        { role: "user", content: prompt }
      ], { signal }) as any;

      const raw = result.raw;
      const usage = raw?.usage_metadata || (raw as any)?.additional_kwargs?.tokenUsage;

      return { 
        classification: result.parsed.classification,
        usage: usage ? {
            inputTokens: usage.input_tokens || usage.promptTokens || 0,
            outputTokens: usage.output_tokens || usage.completionTokens || 0
        } : undefined
      };
    } catch (e: any) {
      if (e.name === 'AbortError') throw e; 
      // Default to allowed if classification fails for other reasons
      console.error("[PromptAnalyser] Classification failed:", e);
      return { classification: 'KONGR' };
    }
  }

  static getRefusalMessage(): string {
    return `I am here to help with Kong Gateway operations only. For questions about world leaders, general trivia, or non-Kong related tasks, I'd recommend checking the official documentation or appropriate resources.\n\n` +
           `Let me know how I can assist you with your **Kong Gateway setup**, **configuration**, or any **GitOps/decK** related tasks!`;
  }
}
