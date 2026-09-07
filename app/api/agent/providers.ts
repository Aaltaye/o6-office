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
  /**
   * `estimatedCost` is null when we do not know the model's price. The null is the
   * point: flattening it to zero tells the caller the work was free, which is a very
   * different and much worse claim than saying nothing at all.
   */
  usage: { input: number; output: number; cached: number; estimatedCost: number | null };
  model: string;
};

/**
 * Model choice is configuration, not a constant.
 *
 * Both defaults are each vendor's small fast model, chosen deliberately. These
 * assignments are short, tightly specified, and constrained by a strict schema —
 * summarise a few notes, draft a hundred words, check a draft against its sources. That
 * is not work a frontier model is needed for, and the office can process a whole CSV in
 * one run, so the per-lead cost is what matters.
 *
 * Override with `O6_ANTHROPIC_MODEL` / `O6_OPENAI_MODEL` when a run needs more.
 */
export const DEFAULT_MODELS: Record<ProviderId, string> = {
  anthropic: 'claude-haiku-4-5',
  openai: 'gpt-4.1-mini',
};

/**
 * Models that accept `output_config.effort`.
 *
 * Not cosmetic: sending `effort` to a model that does not support it is an error, not a
 * silently ignored field. Haiku 4.5 is one of those, so the default Anthropic model must
 * not receive it — this list is why the request builder asks before adding it.
 */
const SUPPORTS_EFFORT = new Set([
  'claude-opus-5',
  'claude-opus-4-8',
  'claude-opus-4-7',
  'claude-opus-4-6',
  'claude-sonnet-5',
  'claude-sonnet-4-6',
  'claude-fable-5',
  'claude-fable-5-1',
]);

/**
 * Prices in US dollars per million tokens, verified 2026-09-06 against each vendor's
 * published rates. Update the date when you update the numbers — a stale price quoted
 * confidently is worse than no price.
 */
const PRICING: Record<
  string,
  { input: number; output: number; cachedInput?: number; cacheWrite?: number }
> = {
  // Anthropic bills cache reads at a tenth of input and cache writes at a 1.25x premium
  // (five-minute TTL, which is the default). Both are written out per model rather than
  // derived from a multiplier: the ratio is vendor policy and can differ per model, and a
  // number you can read is worth more here than a number you have to compute.
  'claude-opus-5': { input: 5, output: 25, cachedInput: 0.5, cacheWrite: 6.25 },
  'claude-sonnet-5': { input: 2, output: 10, cachedInput: 0.2, cacheWrite: 2.5 },
  'claude-haiku-4-5': { input: 1, output: 5, cachedInput: 0.1, cacheWrite: 1.25 },
  'gpt-4.1-mini': { input: 0.4, output: 1.6, cachedInput: 0.1 },
};

/**
 * Estimated cost for one completed call.
 *
 * `input` is every input-ish token, which is what the office displays; `cached` and
 * `cacheWrite` are the two slices of it that are billed at their own rates, and the
 * remainder is charged at the base rate.
 *
 * Where a rate is not pinned for a model, those tokens fall back to the full input rate.
 * Falling back is deliberately the expensive direction: cache reads are cheaper than
 * input, so an unpinned read over-states, and that is the right way to be wrong when the
 * number sits next to somebody's API bill. A cache *write* is dearer than input, so
 * pinning it matters more — an unpinned write is the one case where the fallback
 * under-states, and every model that can produce one has its rate on file below.
 *
 * Unknown models return null. The office renders that as unavailable rather than as zero,
 * because a confident $0.00 is a claim that the run was free.
 */
export function estimateCost(
  model: string,
  input: number,
  output: number,
  cached: number,
  cacheWrite = 0,
): number | null {
  const price = PRICING[model];
  if (!price) return null;
  // Clamped rather than trusted: a provider that reports more cached tokens than input
  // ones should not be able to drive a bill negative.
  const metered = Math.min(cached + cacheWrite, input);
  const uncached = Math.max(0, input - metered);
  const cachedRate = price.cachedInput ?? price.input;
  const writeRate = price.cacheWrite ?? price.input;
  return (
    (uncached * price.input +
      cached * cachedRate +
      cacheWrite * writeRate +
      output * price.output) /
    1e6
  );
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
        // `effort` is only sent to models that accept it — on the rest it is an error,
        // not an ignored field. Low is the honest setting for work this bounded.
        ...(SUPPORTS_EFFORT.has(request.model) ? { effort: 'low' } : {}),
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
  const cacheWrite = usage.cache_creation_input_tokens ?? 0;
  // Every input-ish token, which is the figure the office shows. The three slices are
  // billed at three different rates, so they are kept apart for the price math below
  // rather than collapsed here — folding cache creation into plain input charged a 1.25x
  // line item at 1x, and quietly under-stated the bill.
  const input = (usage.input_tokens ?? 0) + cacheWrite + cached;
  const output = usage.output_tokens ?? 0;

  return {
    text,
    usage: {
      input,
      output,
      cached,
      estimatedCost: estimateCost(request.model, input, output, cached, cacheWrite),
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
      estimatedCost: estimateCost(request.model, input, output, cached),
    },
    model: request.model,
  };
}

export function callProvider(provider: ProviderId, request: ProviderRequest) {
  return provider === 'anthropic' ? callAnthropic(request) : callOpenAI(request);
}
