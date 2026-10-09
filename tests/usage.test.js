import test from 'node:test';
import assert from 'node:assert/strict';
import { createUsageAccumulator, normalizeUsage } from '../usage.js';

const counts = value => {
    const { inputTokens, uncachedInputTokens, cachedInputTokens, cacheWriteTokens, outputTokens, hitRate } = value;
    return { inputTokens, uncachedInputTokens, cachedInputTokens, cacheWriteTokens, outputTokens, hitRate };
};
const expected = (inputTokens, uncachedInputTokens, cachedInputTokens, cacheWriteTokens, outputTokens, hitRate) =>
    ({ inputTokens, uncachedInputTokens, cachedInputTokens, cacheWriteTokens, outputTokens, hitRate });

test('empty, irrelevant, and nonobject payloads have unknown usage', () => {
    for (const value of [undefined, null, false, 7, 'text', [], {}, { choices: [] }, { usage: null }]) {
        assert.deepEqual(counts(normalizeUsage(value)), expected(null, null, null, null, null, null));
        assert.equal(normalizeUsage(value).format, null);
    }
});

test('OpenAI prompt detail cache is a subset of prompt total', () => {
    const result = normalizeUsage({ usage: { prompt_tokens: 100, completion_tokens: 12, prompt_tokens_details: { cached_tokens: 75 }, completion_tokens_details: { reasoning_tokens: 7 } } });
    assert.deepEqual(counts(result), expected(100, 25, 75, null, 12, 0.75));
    assert.equal(result.format, 'openai');
    assert.equal(result.provider, 'openai');
});

test('OpenAI absent cache is unknown, explicit zero cache is known', () => {
    assert.deepEqual(counts(normalizeUsage({ prompt_tokens: 10, completion_tokens: 2 })), expected(10, null, null, null, 2, null));
    assert.deepEqual(counts(normalizeUsage({ prompt_tokens: 10, prompt_tokens_details: { cached_tokens: 0 } })), expected(10, 10, 0, null, null, 0));
});

test('OpenAI Responses input_tokens_details supported', () => {
    assert.deepEqual(counts(normalizeUsage({ usage: { input_tokens: 120, output_tokens: 8, input_tokens_details: { cached_tokens: 20 } } })), expected(120, 100, 20, null, 8, 1 / 6));
});

test('OpenRouter details expose writes without double counting input', () => {
    const result = normalizeUsage({ usage: { prompt_tokens: 100, completion_tokens: 5, prompt_tokens_details: { cached_tokens: 60, cache_write_tokens: 15 } } });
    assert.deepEqual(counts(result), expected(100, 40, 60, 15, 5, 0.6));
    assert.equal(result.format, 'openrouter');
    assert.deepEqual(counts(normalizeUsage({ usage: { prompt_tokens: 20, cached_tokens: 5, cache_write_tokens: 3 } })), expected(20, 15, 5, 3, null, 0.25));
});

test('provider label retained when supplied', () => {
    const result = normalizeUsage({ provider: 'openrouter', usage: { prompt_tokens: 10, completion_tokens: 1 } });
    assert.equal(result.format, 'openrouter');
    assert.equal(result.provider, 'openrouter');
});

test('DeepSeek derives total from hits and misses', () => {
    const result = normalizeUsage({ usage: { prompt_cache_hit_tokens: 80, prompt_cache_miss_tokens: 20, completion_tokens: 5 } });
    assert.deepEqual(counts(result), expected(100, 20, 80, null, 5, 0.8));
    assert.equal(result.format, 'deepseek');
});

test('DeepSeek explicit total and hit count derive uncached when miss absent', () => {
    assert.deepEqual(counts(normalizeUsage({ usage: { prompt_tokens: 100, prompt_cache_hit_tokens: 40 } })), expected(100, 60, 40, null, null, 0.4));
    assert.deepEqual(counts(normalizeUsage({ prompt_cache_miss_tokens: 20 })), expected(null, 20, null, null, null, null));
    assert.deepEqual(counts(normalizeUsage({ prompt_cache_hit_tokens: 20 })), expected(null, null, 20, null, null, null));
});

test('Anthropic writes are noncached and input total includes every category', () => {
    const result = normalizeUsage({ usage: { input_tokens: 10, cache_read_input_tokens: 80, cache_creation_input_tokens: 10, output_tokens: 25 } });
    assert.deepEqual(counts(result), expected(100, 20, 80, 10, 25, 0.8));
    assert.equal(result.format, 'anthropic');
});

test('Anthropic absent cache is unknown, not fabricated zero', () => {
    assert.deepEqual(counts(normalizeUsage({ usage: { input_tokens: 20, output_tokens: 4 } })), expected(null, null, null, null, 4, null));
    assert.deepEqual(counts(normalizeUsage({ usage: { input_tokens: 20, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } })), expected(20, 20, 0, 0, null, 0));
});

test('Anthropic partial cache categories stay unknown until explicitly reported', () => {
    const acc = createUsageAccumulator();
    assert.deepEqual(counts(acc.ingest({ usage: { input_tokens: 20, output_tokens: 4, cache_read_input_tokens: 10 } })), expected(null, null, 10, null, 4, null));
    assert.deepEqual(counts(acc.ingest({ usage: { cache_creation_input_tokens: 0 } })), expected(30, 20, 10, 0, 4, 1 / 3));
    assert.deepEqual(counts(normalizeUsage({ input_tokens: 20, cache_creation_input_tokens: 5 })), expected(null, 25, null, 5, null, null));
    assert.deepEqual(counts(normalizeUsage({ cache_read_input_tokens: 10, cache_creation_input_tokens: 5 })), expected(null, null, 10, 5, null, null));
});

test('Anthropic streaming start/delta retains inputs and overwrites output', () => {
    const acc = createUsageAccumulator();
    acc.ingest({ type: 'message_start', message: { usage: { input_tokens: 10, cache_read_input_tokens: 30, cache_creation_input_tokens: 10, output_tokens: 1 } } });
    assert.deepEqual(counts(acc.ingest({ type: 'message_delta', usage: { output_tokens: 7 } })), expected(50, 20, 30, 10, 7, 0.6));
    assert.equal(acc.ingest({ type: 'message_delta', usage: { output_tokens: 9 } }).outputTokens, 9);
    assert.equal(acc.ingest({ type: 'content_block_delta', delta: { text: 'hello' } }).outputTokens, 9);
});

test('Gemini output includes thoughts exactly once', () => {
    const result = normalizeUsage({ usageMetadata: { promptTokenCount: 100, cachedContentTokenCount: 40, candidatesTokenCount: 12, thoughtsTokenCount: 8, totalTokenCount: 120 } });
    assert.deepEqual(counts(result), expected(100, 60, 40, null, 20, 0.4));
    assert.equal(result.format, 'gemini');
});

test('Gemini supports absent thoughts/cache and direct metadata', () => {
    assert.deepEqual(counts(normalizeUsage({ promptTokenCount: 10, candidatesTokenCount: 5 })), expected(10, null, null, null, 5, null));
    assert.equal(normalizeUsage({ usageMetadata: { thoughtsTokenCount: 6 } }).outputTokens, 6);
});

test('Gemini partial cumulative snapshots retain candidates and thoughts', () => {
    const acc = createUsageAccumulator();
    acc.ingest({ usageMetadata: { promptTokenCount: 10, cachedContentTokenCount: 5, candidatesTokenCount: 4, thoughtsTokenCount: 2 } });
    assert.equal(acc.ingest({ usageMetadata: { candidatesTokenCount: 7 } }).outputTokens, 9);
    assert.equal(acc.ingest({ usageMetadata: { thoughtsTokenCount: 3 } }).outputTokens, 10);
    assert.equal(acc.snapshot().inputTokens, 10);
});

test('Cohere actual usage tokens take precedence over billed units', () => {
    const result = normalizeUsage({ usage: { tokens: { input_tokens: 25, output_tokens: 10 }, billed_units: { input_tokens: 20, output_tokens: 8 } } });
    assert.deepEqual(counts(result), expected(25, null, null, null, 10, null));
    assert.equal(result.format, 'cohere');
});

test('Cohere billed units are optional fallback in modern and legacy envelopes', () => {
    for (const payload of [{ usage: { billed_units: { input_tokens: 20, output_tokens: 8 } } }, { meta: { billed_units: { input_tokens: 20, output_tokens: 8 } } }]) {
        assert.deepEqual(counts(normalizeUsage(payload)), expected(20, null, null, null, 8, null));
        assert.equal(normalizeUsage(payload).format, 'cohere');
    }
});

test('cumulative snapshots overwrite, including decreases and explicit zero', () => {
    const acc = createUsageAccumulator();
    acc.ingest({ usage: { prompt_tokens: 100, completion_tokens: 3, prompt_tokens_details: { cached_tokens: 60 } } });
    assert.equal(acc.ingest({ usage: { completion_tokens: 8 } }).outputTokens, 8);
    assert.equal(acc.ingest({ completion_tokens: 2 }).outputTokens, 2);
    assert.deepEqual(counts(acc.ingest({ usage: { prompt_tokens: 0, completion_tokens: 0, prompt_tokens_details: { cached_tokens: 0 } } })), expected(0, 0, 0, null, 0, null));
});

test('DeepSeek stream with common OpenAI fields retains its format', () => {
    const acc = createUsageAccumulator();
    acc.ingest({ usage: { prompt_tokens: 100, prompt_cache_hit_tokens: 80, prompt_cache_miss_tokens: 20 } });
    assert.equal(acc.ingest({ usage: { completion_tokens: 7 } }).format, 'deepseek');
    assert.equal(acc.ingest({ usage: { prompt_tokens: 100, completion_tokens: 12 } }).format, 'deepseek');
    assert.deepEqual(counts(acc.snapshot()), expected(100, 20, 80, null, 12, 0.8));
});

test('partial detail fields update derived totals without losing other fields', () => {
    const acc = createUsageAccumulator();
    acc.ingest({ prompt_tokens: 100, completion_tokens: 20 });
    const result = acc.ingest({ prompt_tokens_details: { cached_tokens: 90 } });
    assert.deepEqual(counts(result), expected(100, 10, 90, null, 20, 0.9));
});

test('invalid counts are ignored and reported, not coerced', () => {
    for (const invalid of [-1, 0.5, NaN, Infinity, -Infinity, '12', null, undefined, true, {}, Number.MAX_SAFE_INTEGER + 1]) {
        const acc = createUsageAccumulator();
        acc.ingest({ prompt_tokens: 100, completion_tokens: 5, prompt_tokens_details: { cached_tokens: 20 } });
        const result = acc.ingest({ prompt_tokens: invalid, completion_tokens: invalid, prompt_tokens_details: { cached_tokens: invalid } });
        assert.deepEqual(counts(result), expected(100, 80, 20, null, 5, 0.2));
        assert.ok(result.warnings.length >= 3);
        assert.equal(normalizeUsage({ prompt_tokens: invalid }).inputTokens, null);
    }
});

test('zero denominator and impossible cached count do not produce hit rates', () => {
    assert.equal(normalizeUsage({ prompt_tokens: 0, prompt_tokens_details: { cached_tokens: 0 } }).hitRate, null);
    const result = normalizeUsage({ prompt_tokens: 10, prompt_tokens_details: { cached_tokens: 11 } });
    assert.equal(result.hitRate, null);
    assert.equal(result.uncachedInputTokens, null);
    assert.ok(result.warnings.includes('Cached input tokens exceed total input tokens'));
});

test('summed counts are guarded against safe-integer overflow', () => {
    const result = normalizeUsage({ input_tokens: Number.MAX_SAFE_INTEGER, cache_read_input_tokens: 1, cache_creation_input_tokens: 0 });
    assert.equal(result.inputTokens, null);
    assert.equal(result.hitRate, null);
    assert.ok(result.warnings.length);
    const gemini = normalizeUsage({ usageMetadata: { candidatesTokenCount: Number.MAX_SAFE_INTEGER, thoughtsTokenCount: 1 } });
    assert.equal(gemini.outputTokens, null);
});

test('returned snapshots and warnings cannot mutate accumulator state', () => {
    const acc = createUsageAccumulator();
    const result = acc.ingest({ prompt_tokens: 10, completion_tokens: -1 });
    result.inputTokens = 999;
    result.warnings.push('external');
    const snapshot = acc.snapshot();
    assert.equal(snapshot.inputTokens, 10);
    assert.ok(!snapshot.warnings.includes('external'));
    snapshot.warnings.length = 0;
    assert.ok(acc.snapshot().warnings.length);
});

test('format changes reset incompatible request state', () => {
    const acc = createUsageAccumulator();
    acc.ingest({ prompt_tokens: 100, completion_tokens: 12, prompt_tokens_details: { cached_tokens: 80 } });
    assert.deepEqual(counts(acc.ingest({ usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 3 } })), expected(10, null, null, null, 3, null));
});

test('OpenRouter upgrade retains compatible OpenAI partial counts', () => {
    const acc = createUsageAccumulator();
    acc.ingest({ prompt_tokens: 100, completion_tokens: 4 });
    assert.equal(acc.ingest({ prompt_tokens_details: { cached_tokens: 20, cache_write_tokens: 10 } }).format, 'openrouter');
    assert.equal(acc.ingest({ completion_tokens: 8 }).format, 'openrouter');
    assert.deepEqual(counts(acc.snapshot()), expected(100, 80, 20, 10, 8, 0.2));
});

test('OpenRouter top-level cache-only partials retain earlier totals', () => {
    const acc = createUsageAccumulator();
    acc.ingest({ prompt_tokens: 100, completion_tokens: 4 });
    assert.deepEqual(counts(acc.ingest({ cached_tokens: 20, cache_write_tokens: 5 })), expected(100, 80, 20, 5, 4, 0.2));
    assert.equal(acc.snapshot().format, 'openrouter');
});

test('cache write contradictions are warned without changing reported counts', () => {
    const result = normalizeUsage({ prompt_tokens: 10, prompt_tokens_details: { cached_tokens: 8, cache_write_tokens: 3 } });
    assert.equal(result.cacheWriteTokens, 3);
    assert.ok(result.warnings.includes('Cache write tokens exceed noncached input tokens'));
});

test('separate accumulators and one-shot calls have no shared state', () => {
    const a = createUsageAccumulator();
    const b = createUsageAccumulator();
    a.ingest({ prompt_tokens: 100 });
    assert.equal(b.snapshot().inputTokens, null);
    assert.equal(normalizeUsage({ completion_tokens: 2 }).inputTokens, null);
});
