/** Dependency-free usage normalization. Counts are cumulative, not event deltas. */
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const owns = (value, key) => object(value) && Object.hasOwn(value, key);
const validCount = value => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;

function empty() {
    return { inputTokens: null, uncachedInputTokens: null, cachedInputTokens: null,
        cacheWriteTokens: null, outputTokens: null, hitRate: null, format: null, provider: null };
}

function extract(payload) {
    if (!object(payload)) return null;
    const message = object(payload.message) ? payload.message : null;
    const meta = payload.usageMetadata ?? message?.usageMetadata;
    const usage = payload.usage ?? message?.usage;
    let data;
    let format;
    if (object(meta)) {
        data = meta;
        format = 'gemini';
    } else {
        data = object(usage) ? usage : payload;
        if (owns(data, 'prompt_cache_hit_tokens') || owns(data, 'prompt_cache_miss_tokens')) format = 'deepseek';
        else if (object(data.tokens) || object(data.billed_units) || object(payload.meta?.billed_units)) {
            format = 'cohere';
            data = object(data.tokens) ? data.tokens : object(data.billed_units) ? data.billed_units : payload.meta.billed_units;
        } else if (owns(data, 'promptTokenCount') || owns(data, 'cachedContentTokenCount') || owns(data, 'candidatesTokenCount') || owns(data, 'thoughtsTokenCount')) format = 'gemini';
        else if (owns(data, 'cache_read_input_tokens') || owns(data, 'cache_creation_input_tokens') ||
            payload.type === 'message_start' || payload.type === 'message_delta') format = 'anthropic';
        else if (owns(data, 'prompt_tokens') || owns(data, 'completion_tokens') || object(data.prompt_tokens_details) ||
            owns(data, 'cached_tokens') || owns(data, 'cache_write_tokens')) format = 'openai';
        else if (object(data.input_tokens_details)) format = 'openai';
        else if (owns(data, 'input_tokens') || owns(data, 'output_tokens')) format = 'anthropic';
        else return null;
        if (format === 'openai' && (owns(data, 'cache_write_tokens') || owns(data, 'cached_tokens') ||
            owns(data.prompt_tokens_details, 'cache_write_tokens') || payload.provider === 'openrouter')) format = 'openrouter';
    }
    return { data, format, provider: typeof payload.provider === 'string' ? payload.provider : format };
}

function mergeCounts(raw, mapping, warnings) {
    for (const [key, source, name] of mapping) {
        if (!owns(source, name)) continue;
        if (validCount(source[name])) raw[key] = source[name];
        else warnings.add(`Ignored invalid token count: ${name}`);
    }
}

function normalize(raw, format, provider, warnings) {
    const result = { ...empty(), format, provider };
    const known = key => validCount(raw[key]);
    const sum = values => {
        const value = values.reduce((total, n) => total + n, 0);
        if (validCount(value)) return value;
        warnings.add('Token count total exceeds the safe integer range');
        return null;
    };
    result.cachedInputTokens = raw.cached ?? null;
    result.cacheWriteTokens = raw.write ?? null;
    result.outputTokens = raw.output ?? null;
    if (format === 'anthropic') {
        // Anthropic input_tokens excludes both cache reads and cache writes.
        // Missing cache categories are unknown, never silently assumed zero.
        result.uncachedInputTokens = known('uncached') && known('write') ? sum([raw.uncached, raw.write]) : null;
        result.inputTokens = known('uncached') && known('cached') && known('write') ? sum([raw.uncached, raw.cached, raw.write]) : null;
    } else if (format === 'deepseek') {
        result.inputTokens = raw.input ?? (known('cached') && known('uncached') ? sum([raw.cached, raw.uncached]) : null);
        result.uncachedInputTokens = raw.uncached ?? null;
        if (result.uncachedInputTokens === null && result.inputTokens !== null && known('cached') && raw.cached <= result.inputTokens) {
            result.uncachedInputTokens = result.inputTokens - raw.cached;
        }
    } else {
        result.inputTokens = raw.input ?? null;
        if (result.inputTokens !== null && known('cached') && raw.cached <= result.inputTokens) {
            result.uncachedInputTokens = result.inputTokens - raw.cached;
        }
        if (format === 'gemini' && (known('candidates') || known('thoughts'))) {
            result.outputTokens = sum([raw.candidates ?? 0, raw.thoughts ?? 0]);
        }
    }
    let consistent = true;
    if (result.inputTokens !== null && result.cachedInputTokens !== null && result.cachedInputTokens > result.inputTokens) {
        warnings.add('Cached input tokens exceed total input tokens');
        result.uncachedInputTokens = null;
        consistent = false;
    }
    if (result.cacheWriteTokens !== null && result.uncachedInputTokens !== null && result.cacheWriteTokens > result.uncachedInputTokens) {
        warnings.add('Cache write tokens exceed noncached input tokens');
    }
    if (consistent && result.inputTokens > 0 && result.cachedInputTokens !== null) {
        result.hitRate = result.cachedInputTokens / result.inputTokens;
    }
    if (warnings.size) result.warnings = [...warnings];
    return result;
}

/**
 * A request-local accumulator. ingest accepts parsed provider responses, usage
 * objects, or Anthropic message_start/message_delta events. Explicit valid
 * counts overwrite prior counts; missing or invalid counts retain prior values.
 * Feed separate requests to separate accumulators. A provider-format change
 * resets counts (OpenAI/OpenRouter are compatible and share their counts).
 * Gemini omits thoughtsTokenCount when there are no reported thought tokens;
 * it is treated as zero for output aggregation, unlike missing cache counts.
 * Bare input_tokens/output_tokens without input_tokens_details are ambiguous
 * and treated as Anthropic; OpenAI Responses details identify OpenAI format.
 */
export function createUsageAccumulator() {
    let raw = {};
    let format = null;
    let provider = null;
    let warnings = new Set();
    let current = empty();
    const snapshot = () => ({ ...current, ...(current.warnings ? { warnings: [...current.warnings] } : {}) });
    return {
        ingest(payload) {
            const extracted = extract(payload);
            if (!extracted) return snapshot();
            const next = extracted.format;
            const compatible = ['openai', 'openrouter'].includes(format) && ['openai', 'openrouter'].includes(next);
            const commonDeepSeek = format === 'deepseek' && next === 'openai' && !payload.provider;
            // Partial DeepSeek/Anthropic events may only contain common output fields.
            const partial = !object(extracted.data.tokens) && !object(payload?.usage?.tokens) &&
                !object(payload?.usage?.billed_units) && !object(payload?.meta?.billed_units) &&
                !payload?.provider && !payload?.type && !owns(extracted.data, 'prompt_tokens') &&
                !owns(extracted.data, 'input_tokens') && !owns(extracted.data, 'promptTokenCount') &&
                (owns(extracted.data, 'completion_tokens') || owns(extracted.data, 'output_tokens')) &&
                !owns(extracted.data, 'cache_read_input_tokens') && !owns(extracted.data, 'cache_creation_input_tokens') &&
                !owns(extracted.data, 'prompt_cache_hit_tokens') && !owns(extracted.data, 'prompt_cache_miss_tokens');
            if (format && format !== next && !compatible && !partial && !commonDeepSeek) {
                raw = {};
                warnings = new Set();
            }
            if ((!partial && !commonDeepSeek) || !format) {
                format = compatible && format === 'openrouter' ? format : next;
                provider = typeof payload.provider === 'string' ? payload.provider : format;
            }
            const data = extracted.data;
            const details = data.prompt_tokens_details ?? data.input_tokens_details;
            const mapping = format === 'gemini' ? [
                ['input', data, 'promptTokenCount'], ['cached', data, 'cachedContentTokenCount'],
                ['candidates', data, 'candidatesTokenCount'], ['thoughts', data, 'thoughtsTokenCount'],
            ] : format === 'anthropic' ? [
                ['uncached', data, 'input_tokens'], ['cached', data, 'cache_read_input_tokens'],
                ['write', data, 'cache_creation_input_tokens'], ['output', data, 'output_tokens'],
            ] : format === 'cohere' ? [
                ['input', data, 'input_tokens'], ['output', data, 'output_tokens'],
            ] : [
                ['input', data, 'prompt_tokens'], ['input', data, 'input_tokens'],
                ['output', data, 'completion_tokens'], ['output', data, 'output_tokens'],
                ['cached', data, 'cached_tokens'], ['write', data, 'cache_write_tokens'],
                ['cached', details, 'cached_tokens'], ['write', details, 'cache_write_tokens'],
                ...(format === 'deepseek' ? [['cached', data, 'prompt_cache_hit_tokens'], ['uncached', data, 'prompt_cache_miss_tokens']] : []),
            ];
            mergeCounts(raw, mapping, warnings);
            current = normalize(raw, format, provider, warnings);
            return snapshot();
        },
        snapshot,
    };
}

/** Normalize one payload without retaining state. Unknown fields are null. */
export function normalizeUsage(payload) {
    return createUsageAccumulator().ingest(payload);
}
