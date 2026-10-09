import test from 'node:test';
import assert from 'node:assert/strict';
import { createSseParser, observeResponse } from '../capture.js';

const encoder = new TextEncoder();
const streamResponse = chunks => new Response(new ReadableStream({
    start(controller) {
        for (const chunk of chunks) controller.enqueue(typeof chunk === 'string' ? encoder.encode(chunk) : chunk);
        controller.close();
    },
}), { headers: { 'content-type': 'text/event-stream; charset=utf-8', 'x-test': 'preserved' } });

function parse(chunks) {
    const payloads = [];
    const parser = createSseParser(payload => payloads.push(payload));
    chunks.forEach(chunk => parser.push(chunk));
    parser.finish();
    return payloads;
}

test('SSE parses LF, comments, multiline data, heartbeats, DONE and final unterminated event', () => {
    assert.deepEqual(parse([
        ': heartbeat\n\nevent: message\ndata: {"usage":\ndata: {"prompt_tokens":12}}\n\n',
        'data: not JSON\n\ndata: [DONE]\n\ndata: {"tail":true}',
    ]), [{ usage: { prompt_tokens: 12 } }, { tail: true }]);
});

test('SSE parses CRLF at every pair of chunk boundaries, including between CR and LF', () => {
    const text = 'data: {"a":1}\r\n\r\ndata: {"b":2}\r\n\r\ndata: [DONE]\r\n\r\n';
    for (let first = 0; first <= text.length; first++) {
        for (let second = first; second <= text.length; second++) {
            assert.deepEqual(parse([text.slice(0, first), text.slice(first, second), text.slice(second)]),
                [{ a: 1 }, { b: 2 }], `chunk boundaries ${first}, ${second}`);
        }
    }
    assert.deepEqual(parse([...text]), [{ a: 1 }, { b: 2 }]);
});

test('SSE permits mixed LF and CRLF event separators', () => {
    assert.deepEqual(parse(['data: {"a":1}\r', '\n\n', 'data: {"b":2}\n\r', '\n']), [{ a: 1 }, { b: 2 }]);
});

test('stream observation preserves every UTF-8 byte, status and headers while collecting usage', async () => {
    const text = 'data: {"delta":"中文🙂"}\r\n\r\ndata: {"usage":{"prompt_tokens":30}}\r\n\r\ndata: [DONE]\r\n\r\n';
    const bytes = encoder.encode(text);
    const payloads = [];
    const finishes = [];
    const original = streamResponse(Array.from(bytes, byte => Uint8Array.of(byte)));
    const observed = observeResponse(original, payload => payloads.push(payload), success => finishes.push(success));
    assert.notEqual(observed, original);
    assert.equal(observed.status, original.status);
    assert.equal(observed.statusText, original.statusText);
    assert.equal(observed.headers.get('x-test'), 'preserved');
    assert.deepEqual(new Uint8Array(await observed.arrayBuffer()), bytes);
    assert.deepEqual(payloads, [{ delta: '中文🙂' }, { usage: { prompt_tokens: 30 } }]);
    assert.deepEqual(finishes, [true]);
});

test('SSE is observed only as the returned body is consumed, without a background tee', async () => {
    const payloads = [];
    const finishes = [];
    const observed = observeResponse(streamResponse(['data: {"usage":{"prompt_tokens":1}}\n\n']),
        value => payloads.push(value), value => finishes.push(value));
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(payloads, []);
    assert.deepEqual(finishes, []);
    await observed.text();
    assert.deepEqual(payloads, [{ usage: { prompt_tokens: 1 } }]);
    assert.deepEqual(finishes, [true]);
});

test('JSON observation preserves response identity and returned payload', async () => {
    const data = { choices: [{ message: { content: 'answer' } }], usage: { prompt_tokens: 7 } };
    const response = new Response(JSON.stringify(data), { headers: { 'content-type': 'application/json' } });
    const payloads = [];
    const finishes = [];
    const observed = observeResponse(response, value => payloads.push(value), value => finishes.push(value));
    assert.equal(observed, response);
    assert.deepEqual(payloads, []);
    assert.deepEqual(await observed.json(), data);
    assert.deepEqual(payloads, [data]);
    assert.deepEqual(finishes, [true]);
});

test('HTTP errors pass through unchanged and finish unsuccessfully without ingesting usage', async () => {
    const response = new Response('{"usage":{"prompt_tokens":9}}', { status: 500 });
    const payloads = [];
    const finishes = [];
    assert.equal(observeResponse(response, value => payloads.push(value), value => finishes.push(value)), response);
    assert.deepEqual(await response.json(), { usage: { prompt_tokens: 9 } });
    assert.deepEqual(payloads, []);
    assert.deepEqual(finishes, [false]);
});

test('JSON error envelopes finish unsuccessfully', async () => {
    const finishes = [];
    const observed = observeResponse(new Response('{"error":{"message":"failed"}}'), () => {}, value => finishes.push(value));
    assert.deepEqual(await observed.json(), { error: { message: 'failed' } });
    assert.deepEqual(finishes, [false]);
});

test('malformed JSON preserves the parse rejection and finishes unsuccessfully', async () => {
    const payloads = [];
    const finishes = [];
    const observed = observeResponse(new Response('not JSON'), value => payloads.push(value), value => finishes.push(value));
    await assert.rejects(observed.json(), SyntaxError);
    assert.deepEqual(payloads, []);
    assert.deepEqual(finishes, [false]);
});

test('SSE lone-CR line endings are valid event separators', () => {
    assert.deepEqual(parse(['data: {"a":1}\r\rdata: {"b":2}\r\r']), [{ a: 1 }, { b: 2 }]);
});

test('SSE error envelopes finish unsuccessfully', async () => {
    const finishes = [];
    const observed = observeResponse(streamResponse(['data: {"error":{"message":"failed"}}\n\n']), () => {}, value => finishes.push(value));
    await observed.text();
    assert.deepEqual(finishes, [false]);
});

test('errored SSE streams finish unsuccessfully and preserve the read rejection', async () => {
    const failure = new Error('connection lost');
    const response = new Response(new ReadableStream({ start(controller) { controller.error(failure); } }),
        { headers: { 'content-type': 'text/event-stream' } });
    const finishes = [];
    const observed = observeResponse(response, () => {}, value => finishes.push(value));
    await assert.rejects(observed.text(), error => error === failure);
    assert.deepEqual(finishes, [false]);
});
