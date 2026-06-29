import OpenAI from 'openai';
import { systemPrompt, setSystemPrompt as setBuilderSystemPrompt, buildUserMessage, type AntDecisionInput } from './PromptBuilder';
import { parseDecisions, type ParsedDecision } from './ResponseParser';

export interface LLMClientOptions {
  apiKey: string;
  baseURL: string;
  model: string;
  timeoutMs: number;
  maxRetries: number;
}

export class LLMClient {
  private client: OpenAI;
  private model: string;
  private currentSystemPrompt: string;

  constructor(options: LLMClientOptions) {
    this.client = new OpenAI({
      apiKey: options.apiKey,
      baseURL: options.baseURL,
      timeout: options.timeoutMs,
      maxRetries: options.maxRetries,
    });
    this.model = options.model;
    this.currentSystemPrompt = systemPrompt;
  }

  setSystemPrompt(value: string): void {
    this.currentSystemPrompt = value;
    setBuilderSystemPrompt(value);
  }

  async decideBatch(ants: AntDecisionInput[]): Promise<ParsedDecision[]> {
    if (ants.length === 0) return [];

    const userMessage = buildUserMessage(ants);
    console.log(`LLM call: ${ants.length} ants, model=${this.model}`);
    console.log('LLM request payload:', userMessage.slice(0, 4000) + (userMessage.length > 4000 ? '...' : ''));

    // Cerebras prompt caching works automatically by prefix matching. The static
    // system prompt and tool schema come first; the dynamic user payload comes last.
    // No prompt_cache_key is set because all requests share the same system prefix.
    const completion = await this.client.chat.completions.create({
      model: this.model,
      messages: [
        { role: 'system', content: this.currentSystemPrompt },
        { role: 'user', content: userMessage },
      ],
      tools: [
        {
          type: 'function',
          function: {
            name: 'submit_decisions',
            description: 'Submit one movement direction per ant',
            parameters: {
              type: 'object',
              properties: {
                decisions: {
                  type: 'array',
                  items: {
                    type: 'object',
                    properties: {
                      ant_id: { type: 'string' },
                      target: {
                        type: 'string',
                        enum: [
                          'forward left',
                          'left',
                          'hard left',
                          'forward right',
                          'right',
                          'hard right',
                        ],
                        description: 'Direction the ant should move relative to its current heading',
                      },
                    },
                    required: ['ant_id', 'target'],
                  },
                },
              },
              required: ['decisions'],
            },
          },
        },
      ],
      tool_choice: {
        type: 'function',
        function: { name: 'submit_decisions' },
      },
      temperature: 0.3,
    });

    const choice = completion.choices[0];
    const toolCall = choice?.message?.tool_calls?.[0];
    if (!toolCall || toolCall.type !== 'function' || toolCall.function.name !== 'submit_decisions') {
      throw new Error('LLM did not call submit_decisions');
    }

    const usage = completion.usage as unknown as Record<string, unknown> | undefined;
    const promptDetails =
      usage && typeof usage.prompt_tokens_details === 'object' && usage.prompt_tokens_details !== null
        ? (usage.prompt_tokens_details as Record<string, unknown>)
        : undefined;
    const cachedTokens = promptDetails ? (promptDetails.cached_tokens as number | undefined) : undefined;

    console.log('LLM usage:', {
      promptTokens: completion.usage?.prompt_tokens,
      completionTokens: completion.usage?.completion_tokens,
      cachedTokens,
    });
    console.log('LLM raw response arguments:', toolCall.function.arguments);

    return parseDecisions(toolCall.function.arguments);
  }
}
