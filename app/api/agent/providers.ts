/**
 * Provider adapters for the drafting assignments.
 *
 * Two providers, one validation path. The schema check and the exact-source-quote check
 * live in the route and run identically for both — forking them would mean one provider
 * quietly getting weaker guarantees than the other, and the quote check is the thing
 * standing between a personalised draft and an invented one.
 *
 * Raw HTTP rather than each vendor's SDK: this is a single small proxy running in a
 * Cloudflare Worker, it already spoke raw HTTP to OpenAI, and adding an SDK for one
 * provider only would leave the file half in each idiom.
 *
 * Which provider runs is inferred from the key you paste. Anthropic keys start `sk-ant-`;
 * anything else is treated as OpenAI. Nothing to configure, and nothing to get wrong.
 */

export type ProviderId = 'anthropic' | 'openai';
export type Task = 'context' | 'draft' | 'review';

export type ProviderResult = {
  /** Raw JSON text the model produced, before schema and quote validation. */
  text: string;
  usage: { input: number; output: number; cached: number; estimatedCost: number };
  model: string;
};

/**
 * Model choice is configuration, not a constant.
 *
 * The defaults are each vendor's current general model. They are deliberately not the
 * cheapest option available: picking a smaller model to save money is a decision for
 * whoever is paying, so it is exposed rather than assumed. Override with
 * `O6_ANTHROPIC_MODEL` / `O6_OPENAI_MODEL`.
 */
export const DEFAULT_MODELS: Record<ProviderId, string> = {
  anthropic: 'claude-opus-5',
  openai: 'gpt-4.1-mini',
};

/**
 * Prices in US dollars per million tokens, verified 2026-09-06 against each vendor's
 * published rates. Update the date when you update the numbers — a stale price quoted
 * confidently is worse than no price.
 */
const PRICING: Record<string, { input: number; output: number; cachedInput?: number }> = {
  'claude-opus-5': { input: 5, output: 25 },
  'claude-sonnet-5': { input: 2, output: 10 },
  'claude-haiku-4-5': { input: 1, output: 5 },
  'gpt-4.1-mini': { input: 0.4, output: 1.6, cachedInput: 0.1 },
};

/**
 * Estimated cost for one completed call.
 *
 * Where a cached-input rate is not pinned for a model, cached tokens are priced at the
 * full input rate. That makes the figure an upper bound rather than an optimistic guess,
 * which is the right direction to be wrong in when the number is shown next to somebody's
 * API bill. Unknown models return null — the office renders that as unavailable rather
 * than as zero.
 */
export function estimateCost(
  model: string,
  input: number,
  output: number,
  cached: number,
): number | null {
  const price = PRICING[model];
  if (!price) return null;
  const uncached = Math.max(0, input - cached);
  const cachedRate = price.cachedInput ?? price.input;
  return (uncached * price.input + cached * cachedRate + output * price.output) / 1e6;
}

/** Anthropic keys are unmistakable; everything else goes to OpenAI. */
export function providerForKey(key: string): ProviderId {
  return key.startsWith('sk-ant-') ? 'anthropic' : 'openai';
}

/** Per-provider key shape. Rejected early so a typo never reaches a vendor. */
export function isValidKey(provider: ProviderId, key: string): boolean {
  return provider === 'anthropic'
    ? /^sk-ant-[\w-]{20,}$/.test(key)
    : /^sk-[\w-]{10,}$/.test(key);
}

export type ProviderRequest = {
  key: string;
  model: string;
  task: Task;
  instructions: string;
  input: string;
  schema: object;
  signal: AbortSignal;
};

export class ProviderError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}

/** Map a vendor HTTP status onto a message the office can show a human. */
function describeFailure(vendor: string, status: number): ProviderError {
  if (status === 401) {
    return new ProviderError(`The ${vendor} API key was rejected. Check it in run settings.`, 401);
  }
  if (status === 429) {
    return new ProviderError(
      `${vendor} reported a rate or billing limit. Check your API account and retry.`,
      502,
    );
  }
  return new ProviderError(
    `The AI service could not complete the assignment (HTTP ${status}).`,
    502,
  );
}

async function callAnthropic(request: ProviderRequest): Promise<ProviderResult> {
  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    signal: request.signal,
    headers: {
      'x-api-key': request.key,
      'anthropic-version': '2023-06-01',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: request.model,
      max_tokens: 2000,
      system: request.instructions,
      messages: [{ role: 'user', content: request.input }],
      // Structured outputs constrain the response to the same schema the OpenAI path
      // uses, so the validation downstream is genuinely identical for both providers.
      output_config: {
        format: { type: 'json_schema', schema: request.schema },
        // These are short, tightly specified extraction and drafting tasks against a
        // strict schema. Low effort is the honest setting for the work, not a quiet
        // cost saving at the expense of quality.
        effort: 'low',
      },
    }),
  });

  if (!response.ok) throw describeFailure('Anthropic', response.status);

  const body = (await response.json()) as {
    stop_reason?: string;
    content?: { type: string; text?: string }[];
    usage?: {
      input_tokens?: number;
      output_tokens?: number;
      cache_read_input_tokens?: number;
      cache_creation_input_tokens?: number;
    };
  };

  // A refusal is a real outcome, not a malformed response. Say so plainly instead of
  // letting it surface as an unreadable-output error.
  if (body.stop_reason === 'refusal') {
    throw new ProviderError('The model declined this assignment. Review the lead by hand.', 502);
  }

  const text = (body.content ?? [])
    .filter((block) => block.type === 'text')
    .map((block) => block.text ?? '')
    .join('');
  if (!text) throw new ProviderError('No usable output was returned by the AI service.', 502);

  const usage = body.usage ?? {};
  const cached = usage.cache_read_input_tokens ?? 0;
  // Cache *creation* is billed as input, so it is counted as input rather than dropped.
  const input = (usage.input_tokens ?? 0) + (usage.cache_creation_input_tokens ?? 0) + cached;
  const output = usage.output_tokens ?? 0;

  return {
    text,
    usage: {
      input,
      output,
      cached,
      estimatedCost: estimateCost(request.model, input, output, cached) ?? 0,
    },
    model: request.model,
  };
}

async function callOpenAI(request: ProviderRequest): Promise<ProviderResult> {
  const response = await fetch('https://api.openai.com/v1/responses', {
    method: 'POST',
    signal: request.signal,
    headers: { Authorization: `Bearer ${request.key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: request.model,
      store: false,
      max_output_tokens: 1000,
      instructions: request.instructions,
      input: request.input,
      text: {
        format: {
          type: 'json_schema',
          name: `o6_${request.task}`,
          strict: true,
          schema: request.schema,
        },
      },
    }),
  });

  if (!response.ok) throw describeFailure('OpenAI', response.status);

  const body = (await response.json()) as {
    status: string;
    output?: { content?: { type: string; text?: string }[] }[];
    usage?: {
      input_tokens: number;
      output_tokens: number;
      input_tokens_details?: { cached_tokens: number };
    };
  };

  if (body.status !== 'completed') {
    throw new ProviderError('The AI response was incomplete. This lead needs another review.', 502);
  }

  const text = (body.output ?? [])
    .flatMap((item) => item.content ?? [])
    .filter((block) => block.type === 'output_text')
    .map((block) => block.text ?? '')
    .join('');
  if (!text) throw new ProviderError('No usable output was returned by the AI service.', 502);

  const input = body.usage?.input_tokens ?? 0;
  const output = body.usage?.output_tokens ?? 0;
  const cached = body.usage?.input_tokens_details?.cached_tokens ?? 0;

  return {
    text,
    usage: {
      input,
      output,
      cached,
      estimatedCost: estimateCost(request.model, input, output, cached) ?? 0,
    },
    model: request.model,
  };
}

export function callProvider(provider: ProviderId, request: ProviderRequest) {
  return provider === 'anthropic' ? callAnthropic(request) : callOpenAI(request);
}
