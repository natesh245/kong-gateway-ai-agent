import OpenAI from "openai";

export class PromptAnalyser {
  /**
   * Analyzes if a user prompt is related to Kong Gateway or off-topic.
   * Returns 'KONGR' for Kong Related or 'OFFT' for Off Topic, along with token usage.
   */
  static async classify(prompt: string, openai: OpenAI, model: string): Promise<{ classification: 'KONGR' | 'OFFT', usage?: { inputTokens: number, outputTokens: number } }> {
    try {
      const response = await openai.chat.completions.create({
        model: model,
        messages: [
          {
            role: "system",
            content: "You are a strict query classifier for a Kong Gateway specialist agent.\n\n" +
                     "CATEGORIES:\n" +
                     "- KONGR: Technical queries about Kong Gateway, Docker, decK, GitOps, API management, or local config files. ALSO INCLUDES workflow confirmations, affirmations, and denials (e.g., 'Yes', 'No', 'Proceed', 'Stop', 'Approve', 'Cancel').\n" +
                     "- OFFT: Jokes, humor, poetry, general trivia, world events, or small talk. \n\n" +
                     "CRITICAL RULE: Even if a joke or query mentions 'Kong', if the intent is humor or off-topic (e.g. 'tell me a kong joke'), it MUST be classified as OFFT.\n\n" +
                     "EXAMPLES:\n" +
                     "- User: 'How do I add a service?' -> KONGR\n" +
                     "- User: 'Yes' -> KONGR\n" +
                     "- User: 'Proceed' -> KONGR\n" +
                     "- User: 'No, cancel' -> KONGR\n" +
                     "- User: 'Tell me a joke.' -> OFFT\n" +
                     "- User: 'Tell me a Kong joke.' -> OFFT\n" +
                     "- User: 'Who is the president?' -> OFFT\n" +
                     "- User: 'What is decK sync?' -> KONGR\n" +
                     "- User: 'Write a poem about Kong.' -> OFFT\n\n" +
                     "Output ONLY the code 'KONGR' or 'OFFT'."
          },
          { role: "user", content: prompt }
        ],
        temperature: 0,
        max_tokens: 5
      });

      const result = response.choices[0]?.message?.content?.trim().toUpperCase() || 'KONGR';
      const classification = result.includes('OFFT') ? 'OFFT' : 'KONGR';
      
      const usage = response.usage ? {
        inputTokens: response.usage.prompt_tokens,
        outputTokens: response.usage.completion_tokens
      } : undefined;

      return { classification, usage };
    } catch (e) {
      // Default to allowed if classification fails to ensure service continuity
      console.error("[PromptAnalyser] Classification failed:", e);
      return { classification: 'KONGR' };
    }
  }

  static getRefusalMessage(): string {
    return `I am here to help with Kong Gateway operations only. For questions about world leaders, general trivia, or non-Kong related tasks, I'd recommend checking the official documentation or appropriate resources.\n\n` +
           `Let me know how I can assist you with your **Kong Gateway setup**, **configuration**, or any **GitOps/decK** related tasks!`;
  }
}
