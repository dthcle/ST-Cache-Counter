import test from 'node:test';
import assert from 'node:assert/strict';

const KEY = 'st_cache_counter';
const endpoint = '/api/backends/chat-completions/generate';
let importSerial = 0;
const usagePayload = (input = 100, cached = 40, output = 10) => ({
    usage: { prompt_tokens: input, prompt_tokens_details: { cached_tokens: cached }, completion_tokens: output },
});
const jsonResponse = (payload = usagePayload(), status = 200) => new Response(JSON.stringify(payload),
    { status, headers: { 'content-type': 'application/json' } });
const assistant = () => ({ is_user: false, mes: 'answer', swipe_id: 0, swipe_info: [{}, {}] });

async function harness(t) {
    const names = ['SillyTavern', 'document', 'window', 'location'];
    const descriptors = new Map(names.map(name => [name, Object.getOwnPropertyDescriptor(globalThis, name)]));
    t.after(() => {
        for (const [name, descriptor] of descriptors) {
            if (descriptor) Object.defineProperty(globalThis, name, descriptor);
            else delete globalThis[name];
        }
    });
    const listeners = new Map();
    const eventNames = ['GENERATION_STARTED', 'MESSAGE_RECEIVED', 'GENERATION_ENDED', 'CHAT_CHANGED',
        'MESSAGE_EDITED', 'MESSAGE_SWIPED', 'CHARACTER_MESSAGE_RENDERED', 'MESSAGE_UPDATED',
        'MESSAGE_DELETED', 'MORE_MESSAGES_LOADED', 'MESSAGE_SWIPE_DELETED'];
    const context = {
        // Existing assistant targets model ST's established streaming target, not a
        // normal nonstream fetch (whose new assistant is inserted after the request).
        chat: [{ is_user: true, mes: 'question' }, assistant()], chatId: 'chat-a', extensionSettings: {},
        streamingProcessor: { messageId: 1 },
        eventTypes: Object.fromEntries(eventNames.map(name => [name, name])),
        eventSource: { on(name, callback) { const list = listeners.get(name) || []; list.push(callback); listeners.set(name, list); } },
        saveSettingsDebounced() {},
        savedChats: [],
        saveChat() { this.savedChats.push(structuredClone(this.chat)); return Promise.resolve(); },
    };
    const checkbox = { checked: false, addEventListener() {} };
    const document = {
        querySelector: () => null,
        querySelectorAll: () => [],
        createElement: () => ({ className: '', innerHTML: '', querySelector: () => checkbox, append() {} }),
    };
    const responses = [];
    const calls = [];
    const originalFetch = async function (...args) {
        calls.push({ args, receiver: this });
        const next = responses.shift();
        if (next instanceof Error) throw next;
        return next || jsonResponse();
    };
    const window = { fetch: originalFetch };
    for (const [name, value] of Object.entries({ SillyTavern: { getContext: () => context }, document, window,
        location: { href: 'http://localhost:8000/chat', origin: 'http://localhost:8000' } })) {
        Object.defineProperty(globalThis, name, { value, configurable: true, writable: true });
    }
    // A distinct module instance isolates index.js's session, serial and fetch hook.
    await import(`../index.js?integration=${++importSerial}`);
    return {
        context, window, originalFetch, responses, calls,
        emit(name, ...args) { for (const callback of listeners.get(name) || []) callback(...args); },
        fetch(body = {}, url = endpoint) {
            return window.fetch(url, { method: 'POST', body: JSON.stringify({ chat_completion_source: 'openai', model: 'test-model', ...body }) });
        },
    };
}

// Tests deliberately run sequentially: index.js reads process globals at import.
test('nonstream request attaches normalized usage only on MESSAGE_RECEIVED and saves swipe_info', async t => {
    const h = await harness(t);
    h.emit('GENERATION_STARTED', 'normal');
    const response = await h.fetch({ n: 2 });
    assert.deepEqual(await response.json(), usagePayload());
    assert.equal(h.context.chat[1].extra, undefined);
    h.emit('MESSAGE_RECEIVED', 1, 'normal');
    const record = h.context.chat[1].extra[KEY];
    assert.equal(record.version, 1);
    assert.equal(record.requests.length, 1);
    const request = record.requests[0];
    assert.equal(request.source, 'openai');
    assert.equal(request.model, 'test-model');
    assert.equal(request.multiChoice, true);
    assert.equal(request.complete, true);
    assert.equal(Number.isNaN(Date.parse(request.time)), false);
    assert.deepEqual(request.usage, {
        inputTokens: 100, uncachedInputTokens: 60, cachedInputTokens: 40, cacheWriteTokens: null,
        outputTokens: 10, hitRate: 0.4, format: 'openai', provider: 'openai',
    });
    assert.deepEqual(h.context.chat[1].swipe_info[0].extra[KEY], record);
    assert.notEqual(h.context.chat[1].swipe_info[0].extra[KEY], record);
    assert.equal(h.context.chat[1].swipe_info[1].extra, undefined);
    assert.equal(h.calls[0].receiver, h.window);
    assert.equal(h.calls.length, 1);
    h.emit('MESSAGE_RECEIVED', 1, 'normal');
    assert.equal(h.context.chat[1].extra[KEY].requests.length, 1, 'a request attaches only once');
});

test('ST 1.19 streaming finalization preserves bytes and attaches after GENERATION_ENDED then MESSAGE_RECEIVED', async t => {
    const h = await harness(t);
    const wire = 'data: {"choices":[{"delta":{"content":"中文🙂"}}]}\r\n\r\n'
        + `data: ${JSON.stringify(usagePayload(80, 30, 9))}\r\n\r\ndata: [DONE]\r\n\r\n`;
    const bytes = new TextEncoder().encode(wire);
    h.responses.push(new Response(new ReadableStream({ start(controller) {
        for (const byte of bytes) controller.enqueue(Uint8Array.of(byte));
        controller.close();
    } }), { headers: { 'content-type': 'text/event-stream' } }));
    h.emit('GENERATION_STARTED', 'normal');
    const response = await h.fetch({ stream: true });
    assert.deepEqual(new Uint8Array(await response.arrayBuffer()), bytes);
    assert.equal(h.context.chat[1].extra, undefined);
    // ST unlocks generation before its normal streaming MESSAGE_RECEIVED.
    h.emit('GENERATION_ENDED');
    assert.equal(h.context.chat[1].extra, undefined);
    h.emit('MESSAGE_RECEIVED', 1, 'normal');
    h.emit('CHARACTER_MESSAGE_RENDERED', 1, 'normal');
    const request = h.context.chat[1].extra[KEY].requests[0];
    assert.equal(request.complete, true);
    assert.equal(request.usage.inputTokens, 80);
    assert.equal(request.usage.cachedInputTokens, 30);
    assert.equal(request.usage.outputTokens, 9);
});

test('quiet and impersonation generations never capture requests', async t => {
    const h = await harness(t);
    for (const type of ['quiet', 'impersonate']) {
        h.emit('GENERATION_STARTED', type);
        const raw = jsonResponse();
        h.responses.push(raw);
        assert.equal(await h.fetch(), raw);
        await raw.json();
        h.emit('MESSAGE_RECEIVED', 1, type);
        assert.equal(h.context.chat[1].extra, undefined);
        h.emit('GENERATION_ENDED');
    }
});

test('unrelated URLs, malformed/nonstring request bodies, inactive and disabled calls pass through', async t => {
    const h = await harness(t);
    const check = async (url, init) => {
        const raw = jsonResponse();
        h.responses.push(raw);
        assert.equal(await h.window.fetch(url, init), raw);
        await raw.json();
    };
    await check(endpoint, { body: '{}' }); // No generation session.
    h.emit('GENERATION_STARTED', 'normal');
    await check('/api/other', { body: '{}' });
    await check(`https://other.example${endpoint}`, { body: '{}' });
    await check(endpoint, { body: 'not JSON' });
    await check(endpoint, { body: new Uint8Array([1]) });
    h.context.extensionSettings[KEY].enabled = false;
    await check(endpoint, { body: '{}' });
    h.context.extensionSettings[KEY].enabled = true;
    h.emit('MESSAGE_RECEIVED', 1, 'normal');
    assert.equal(h.context.chat[1].extra, undefined);
    assert.equal(h.calls.length, 6);
});

test('HTTP errors, JSON error envelopes, parse errors and fetch rejections are not attached', async t => {
    const h = await harness(t);
    h.emit('GENERATION_STARTED', 'normal');
    h.responses.push(jsonResponse(usagePayload(), 500));
    await (await h.fetch()).json();
    h.responses.push(jsonResponse({ ...usagePayload(), error: { message: 'provider failed' } }));
    await (await h.fetch()).json();
    h.responses.push(new Response('invalid JSON'));
    await assert.rejects((await h.fetch()).json(), SyntaxError);
    const failure = new Error('network failure');
    h.responses.push(failure);
    await assert.rejects(h.fetch(), error => error === failure);
    h.emit('MESSAGE_RECEIVED', 1, 'normal');
    assert.equal(h.context.chat[1].extra, undefined);
});

test('continue appends separate requests and sums their token totals without replacing prior swipe data', async t => {
    const h = await harness(t);
    h.emit('GENERATION_STARTED', 'normal');
    await (await h.fetch()).json();
    h.emit('MESSAGE_RECEIVED', 1, 'normal');
    h.emit('GENERATION_ENDED');
    h.emit('GENERATION_STARTED', 'continue');
    for (const payload of [usagePayload(50, 20, 5), usagePayload(20, 10, 2)]) {
        h.responses.push(jsonResponse(payload));
        await (await h.fetch()).json();
    }
    // ST's nonstream continue is finalized as appendFinal too.
    h.emit('MESSAGE_RECEIVED', 1, 'appendFinal');
    const record = h.context.chat[1].extra[KEY];
    assert.equal(record.requests.length, 3);
    assert.equal(new Set(record.requests.map(request => request.id)).size, 3);
    const sum = key => record.requests.reduce((total, request) => total + request.usage[key], 0);
    assert.equal(sum('inputTokens'), 170);
    assert.equal(sum('cachedInputTokens'), 70);
    assert.equal(sum('uncachedInputTokens'), 100);
    assert.equal(sum('outputTokens'), 17);
    assert.deepEqual(h.context.chat[1].swipe_info[0].extra[KEY], record);
});

test('new swipe gets independent persisted request data while prior swipe is unchanged', async t => {
    const h = await harness(t);
    h.emit('GENERATION_STARTED', 'normal');
    await (await h.fetch()).json();
    h.emit('MESSAGE_RECEIVED', 1, 'normal');
    const prior = structuredClone(h.context.chat[1].swipe_info[0].extra[KEY]);
    h.emit('GENERATION_ENDED');
    h.context.chat[1].swipe_id = 1;
    h.emit('GENERATION_STARTED', 'swipe');
    h.responses.push(jsonResponse(usagePayload(12, 3, 4)));
    await (await h.fetch()).json();
    h.emit('MESSAGE_RECEIVED', 1, 'swipe');
    assert.deepEqual(h.context.chat[1].swipe_info[0].extra[KEY], prior);
    assert.equal(h.context.chat[1].extra[KEY].requests.length, 1);
    assert.equal(h.context.chat[1].extra[KEY].requests[0].usage.inputTokens, 12);
    assert.deepEqual(h.context.chat[1].swipe_info[1].extra[KEY], h.context.chat[1].extra[KEY]);
});

test('changed chat discards requests for CHAT_CHANGED, replacement chat array and changed chatId', async t => {
    const h = await harness(t);
    for (const change of [
        () => h.emit('CHAT_CHANGED'),
        () => { h.context.chat = [{ is_user: true }, assistant()]; },
        () => { h.context.chatId += '-changed'; },
    ]) {
        h.emit('GENERATION_STARTED', 'normal');
        await (await h.fetch()).json();
        change();
        h.emit('MESSAGE_RECEIVED', 1, 'normal');
        assert.equal(h.context.chat[1].extra, undefined);
        h.emit('GENERATION_ENDED');
    }
});

test('an in-flight response from a changed chat cannot attach to a later session', async t => {
    const h = await harness(t);
    let resolveResponse;
    h.responses.push(new Promise(resolve => { resolveResponse = resolve; }));
    h.emit('GENERATION_STARTED', 'normal');
    const pending = h.fetch();
    h.emit('CHAT_CHANGED');
    h.context.chat = [{ is_user: true }, assistant()];
    h.context.chatId = 'chat-b';
    h.emit('GENERATION_STARTED', 'normal');
    resolveResponse(jsonResponse());
    await (await pending).json();
    h.emit('MESSAGE_RECEIVED', 1, 'normal');
    assert.equal(h.context.chat[1].extra, undefined);
});

test('dry runs and user/system message targets do not receive records; ended sessions collect no new requests', async t => {
    const h = await harness(t);
    h.emit('GENERATION_STARTED', 'normal', {}, true);
    await (await h.fetch()).json();
    h.emit('MESSAGE_RECEIVED', 1, 'normal');
    assert.equal(h.context.chat[1].extra, undefined);
    h.emit('GENERATION_STARTED', 'normal');
    await (await h.fetch()).json();
    h.emit('MESSAGE_RECEIVED', 0, 'normal');
    assert.equal(h.context.chat[0].extra, undefined);
    h.context.chat.push({ is_system: true });
    h.emit('MESSAGE_RECEIVED', 2, 'normal');
    assert.equal(h.context.chat[2].extra, undefined);
    h.emit('GENERATION_ENDED');
    await (await h.fetch()).json();
    h.emit('MESSAGE_RECEIVED', 1, 'normal');
    assert.equal(h.context.chat[1].extra[KEY].requests.length, 1);
});

test('late stream usage updates an already attached message', async t => {
    const h = await harness(t);
    h.responses.push(new Response(`data: ${JSON.stringify(usagePayload())}\n\n`,
        { headers: { 'content-type': 'text/event-stream' } }));
    h.emit('GENERATION_STARTED', 'normal');
    const response = await h.fetch({ stream: true });
    h.emit('MESSAGE_RECEIVED', 1, 'normal');
    await response.text();
    const record = h.context.chat[1].extra[KEY];
    assert.equal(record.requests[0].complete, true);
    assert.equal(record.requests[0].usage.inputTokens, 100);
    assert.deepEqual(h.context.chat[1].swipe_info[0].extra[KEY], record);
});

test('quiet overlap and actual request type cannot steal a visible generation', async t => {
    const h = await harness(t);
    h.emit('GENERATION_STARTED', 'normal');
    await (await h.fetch({ type: 'normal' })).json();
    h.emit('GENERATION_STARTED', 'quiet');
    await (await h.fetch({ type: 'quiet' })).json();
    h.emit('GENERATION_STARTED', 'impersonate');
    await (await h.fetch({ type: 'impersonate' })).json();
    h.emit('GENERATION_ENDED');
    h.emit('MESSAGE_RECEIVED', 1, 'normal');
    assert.equal(h.context.chat[1].extra[KEY].requests.length, 1);
});

test('nonstream continuation appendFinal preserves earlier request and edited swipe metadata', async t => {
    const h = await harness(t);
    h.emit('GENERATION_STARTED', 'normal');
    await (await h.fetch()).json();
    h.emit('MESSAGE_RECEIVED', 1, 'normal');
    h.emit('GENERATION_STARTED', 'continue');
    await (await h.fetch({ type: 'continue' })).json();
    h.emit('MESSAGE_RECEIVED', 1, 'appendFinal');
    assert.equal(h.context.chat[1].extra[KEY].requests.length, 2);
    h.emit('MESSAGE_EDITED', 1);
    assert.equal(h.context.chat[1].swipe_info[0].extra[KEY].edited, true);
});

test('normal request without established streaming target binds only the newly inserted message', async t => {
    const h = await harness(t);
    h.context.streamingProcessor = null;
    h.context.chat = [{ is_user: true, mes: 'question' }];
    h.emit('GENERATION_STARTED', 'normal');
    await (await h.fetch({ type: 'normal' })).json();
    h.context.chat.push(assistant());
    h.emit('GENERATION_ENDED');
    h.emit('MESSAGE_RECEIVED', 1, 'normal');
    assert.equal(h.context.chat[1].extra[KEY].requests.length, 1);
});

test('new swipe clears inherited live usage even if provider fails, preserving old candidate', async t => {
    const h = await harness(t);
    h.emit('GENERATION_STARTED', 'normal');
    await (await h.fetch()).json();
    h.emit('MESSAGE_RECEIVED', 1, 'normal');
    const old = structuredClone(h.context.chat[1].swipe_info[0].extra[KEY]);
    h.context.chat[1].swipe_id = 1;
    h.emit('GENERATION_STARTED', 'swipe');
    h.responses.push(jsonResponse({}, 500));
    await h.fetch({ type: 'swipe' });
    assert.equal(h.context.chat[1].extra[KEY], undefined);
    assert.deepEqual(h.context.chat[1].swipe_info[0].extra[KEY], old);
});

test('multiple pending generations targeting the same slot are left unknown rather than misattributed', async t => {
    const h = await harness(t);
    h.emit('GENERATION_STARTED', 'normal'); await (await h.fetch()).json();
    h.emit('GENERATION_ENDED');
    h.emit('GENERATION_STARTED', 'normal'); await (await h.fetch()).json();
    h.emit('MESSAGE_RECEIVED', 1, 'normal');
    assert.equal(h.context.chat[1].extra?.[KEY], undefined);
});

test('canceled stream can preserve already observed partial usage with incomplete status', async t => {
    const h = await harness(t);
    const encoder = new TextEncoder();
    h.responses.push(new Response(new ReadableStream({ start(c) { c.enqueue(encoder.encode(`data: ${JSON.stringify(usagePayload())}\n\n`)); } }), { headers: { 'content-type': 'text/event-stream' } }));
    h.emit('GENERATION_STARTED', 'normal');
    const reader = (await h.fetch({ stream: true })).body.getReader();
    await reader.read(); await reader.cancel();
    h.emit('GENERATION_ENDED'); h.emit('MESSAGE_RECEIVED', 1, 'normal');
    assert.equal(h.context.chat[1].extra[KEY].requests[0].complete, false);
    assert.equal(h.context.chat[1].extra[KEY].requests[0].usage.inputTokens, 100);
});

test('SSE provider errors are not attached to messages', async t => {
    const h = await harness(t);
    h.responses.push(new Response('data: {"error":{"message":"provider failed"}}\n\n',
        { headers: { 'content-type': 'text/event-stream' } }));
    h.emit('GENERATION_STARTED', 'normal');
    await (await h.fetch({ stream: true })).text();
    h.emit('MESSAGE_RECEIVED', 1, 'normal');
    assert.equal(h.context.chat[1].extra, undefined);
});
