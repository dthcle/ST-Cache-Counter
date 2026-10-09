import { createUsageAccumulator } from './usage.js';
import { observeResponse } from './capture.js';

const KEY = 'st_cache_counter';
const context = () => SillyTavern.getContext();
let session = null;
let pending = [];
let serial = 0;
const excludedTypes = new Set(['quiet', 'impersonate', 'first_message']);
const isContinuation = type => ['continue', 'append', 'appendFinal'].includes(type);
// ENDED is a UI event, not an ownership boundary. Bound retention without timers.
function prunePending() {
    const c = context(); const cutoff = Date.now() - 5 * 60 * 1000;
    pending = pending.filter(s => s.chat === c.chat && s.chatId === c.chatId && s.started >= cutoff).slice(-16);
    if (session && !pending.includes(session)) session = null;
}
function hasUsage(request) {
    const usage = request.accumulator.snapshot();
    return ['inputTokens', 'cachedInputTokens', 'cacheWriteTokens', 'outputTokens'].some(key => Number.isFinite(usage[key]));
}
const settings = context().extensionSettings;
settings[KEY] ??= { enabled: true };
const enabled = () => settings[KEY].enabled;

function render() {
    const chat = context().chat;
    document.querySelectorAll('#chat .mes').forEach(element => {
        const message = chat[Number(element.getAttribute('mesid'))];
        let badge = element.querySelector('.stcc-badge');
        if (!enabled() || !message || message.is_user || message.is_system) { badge?.remove(); return; }
        const record = message.extra?.[KEY];
        if (!badge) {
            badge = document.createElement('div'); badge.className = 'stcc-badge';
            (element.querySelector('.mes_block') || element).append(badge);
        }
        const records = record?.requests || [];
        const sum = key => records.length && records.every(r => Number.isFinite(r.usage[key]))
            ? records.reduce((total, r) => total + r.usage[key], 0) : null;
        const input = sum('inputTokens'); const cached = sum('cachedInputTokens');
        const rate = input > 0 && cached !== null && cached <= input && records.every(r => r.usage.hitRate !== null || r.usage.inputTokens === 0) ? cached / input : null;
        const number = x => x === null ? '未知' : x.toLocaleString('zh-CN');
        badge.textContent = `非缓存输入 ${number(sum('uncachedInputTokens'))} · 缓存输入 ${number(cached)} · 输出 ${number(sum('outputTokens'))} · 命中率 ${rate === null ? '未知' : (rate * 100).toFixed(1) + '%'}`;
        badge.title = records.length
            ? `${records.length} 次 API 请求；输入总量 ${number(input)}；缓存写入 ${number(sum('cacheWriteTokens'))}。命中率=缓存读取/输入总量。API未提供的字段显示未知；续写累加，切换候选回复独立保存。${record.edited ? ' 内容已编辑，统计仍为原请求用量。' : ''}${records.some(r => !r.complete) ? ' 含未完成请求，仅为已收到的部分 usage，不代表最终计费。' : ''}${records.some(r => r.multiChoice) ? ' 多候选请求的 usage 是请求总量，不能拆分到各候选。' : ''}`
            : '未记录到实际 API usage；历史消息、开场白或未返回 usage 的接口无法准确补算。';
    });
}

function attach(messageId, type) {
    prunePending();
    const c = context();
    if (excludedTypes.has(type)) return;
    const message = c.chat[messageId];
    if (!message || message.is_user || message.is_system) return;
    const candidates = pending.filter(s => {
        if (!s.expected || !s.requests.some(r => !r.attached && !r.failed && (!r.finished || r.complete || hasUsage(r)))) return false;
        const target = s.expected;
        if (target.id !== messageId || (target.message && target.message !== message)) return false;
        if (target.previous && c.chat[messageId - 1] !== target.previous) return false;
        if (target.swipeId !== undefined && message.swipe_id !== target.swipeId) return false;
        return isContinuation(s.type) ? isContinuation(type) : type === s.type || (s.type === undefined && type === 'normal');
    });
    // Two generations targeting the same slot cannot safely be distinguished by this event.
    if (candidates.length !== 1) return;
    const s = candidates[0];
    const requests = s.requests.filter(r => !r.attached && !r.failed && (!r.finished || r.complete || hasUsage(r)));
    if (!requests.length) return;
    message.extra ??= {};
    const prior = isContinuation(s.type) ? message.extra[KEY]?.requests || [] : [];
    message.extra[KEY] = { version: 1, requests: [...prior, ...requests.map(r => ({
        id: r.id, source: r.source, model: r.model, time: r.time,
        multiChoice: r.multiChoice, complete: r.complete, usage: r.accumulator.snapshot(),
    }))] };
    requests.forEach(r => { r.attached = true; r.message = message; r.swipeId = message.swipe_id; });
    s.target = { message, swipeId: message.swipe_id };
    if (message.swipe_info?.[message.swipe_id]) {
        message.swipe_info[message.swipe_id].extra ??= {};
        message.swipe_info[message.swipe_id].extra[KEY] = structuredClone(message.extra[KEY]);
    }
    render();
}

// Scoped to the ST chat-completion endpoint during a visible generation only.
const originalFetch = window.fetch;
window.fetch = async function (input, init) {
    let body; let url;
    try {
        url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url, location.href);
        if (url.origin === location.origin && url.pathname === '/api/backends/chat-completions/generate' && typeof init?.body === 'string') body = JSON.parse(init.body);
    } catch { /* ordinary unrelated fetch */ }
    prunePending();
    const s = session;
    if (!enabled() || !body || !s || !s.active || excludedTypes.has(s.type) || excludedTypes.has(body.type)) return originalFetch.apply(this, arguments);
    if (body.type !== undefined && body.type !== s.type && !(isContinuation(body.type) && isContinuation(s.type))) return originalFetch.apply(this, arguments);
    const c = context();
    if (!s.expected) {
        const processorId = c.streamingProcessor?.messageId;
        const existingTarget = ['swipe', 'regenerate'].includes(s.type) || isContinuation(s.type);
        const id = Number.isInteger(processorId) && processorId >= 0 ? processorId : existingTarget ? c.chat.length - 1 : c.chat.length;
        const message = c.chat[id];
        s.expected = { id, message: message || null, previous: id > 0 ? c.chat[id - 1] : null, swipeId: message?.swipe_id };
        if (message && !isContinuation(s.type)) {
            // ST may copy old arbitrary extra fields into a newly generated swipe.
            // Preserve the old candidate's saved extra, but clear only the live view.
            if (message.extra?.[KEY]) { message.extra = { ...message.extra }; delete message.extra[KEY]; render(); }
        }
    }
    const request = {
        id: ++serial, source: body.chat_completion_source, model: body.model,
        time: new Date().toISOString(), multiChoice: body.n > 1,
        accumulator: createUsageAccumulator(), complete: false, failed: false, attached: false,
    };
    s.requests.push(request);
    try {
        const response = await originalFetch.apply(this, arguments);
        if (!response.ok) request.failed = true;
        return observeResponse(response, data => {
            if (data.error || data.type === 'error') request.failed = true;
            else request.accumulator.ingest(data);
        }, success => {
            request.finished = true; request.complete = success && !request.failed;
            // Transport cancellation may still have real partial usage. Only HTTP
            // or provider error envelopes are hard failures excluded from binding.
            // An early stop hook can bind before the final usage event arrives.
            if (request.attached && context().chat === s.chat && context().chatId === s.chatId) {
                const message = request.message;
                const update = record => {
                    const saved = record?.requests?.find(r => r.id === request.id && r.time === request.time);
                    if (saved) { saved.usage = request.accumulator.snapshot(); saved.complete = request.complete; }
                };
                if (message.swipe_id === request.swipeId) update(message.extra?.[KEY]);
                update(message.swipe_info?.[request.swipeId]?.extra?.[KEY]);
                render();
                Promise.resolve().then(() => context().saveChat?.()).catch(error => console.warn('[ST Cache Counter] Could not save late usage', error));
            }
        }, { stream: body.stream === true });
    } catch (error) { request.failed = true; throw error; }
};

const { eventSource, eventTypes } = context();
const on = (name, fn) => { if (eventTypes[name]) eventSource.on(eventTypes[name], fn); };
on('GENERATION_STARTED', (type, _options, dryRun) => {
    if (dryRun || excludedTypes.has(type)) return;
    prunePending();
    const c = context(); session = { type, active: true, started: Date.now(), chat: c.chat, chatId: c.chatId, requests: [], target: null };
    pending.push(session);
    prunePending();
});
on('MESSAGE_RECEIVED', attach);
// ST 1.19 streaming unlocks the UI (ENDED) before emitting MESSAGE_RECEIVED.
// Stop collecting new requests, but retain this request context for that event.
on('GENERATION_ENDED', () => { if (session) session.active = false; render(); });
on('CHAT_CHANGED', () => { session = null; pending = []; render(); });
on('MESSAGE_EDITED', id => {
    const message = context().chat[id];
    const record = message?.extra?.[KEY];
    if (record) {
        record.edited = true;
        if (message.swipe_info?.[message.swipe_id]) {
            message.swipe_info[message.swipe_id].extra ??= {};
            message.swipe_info[message.swipe_id].extra[KEY] = structuredClone(record);
        }
    }
    render();
});
for (const name of ['MESSAGE_SWIPED', 'CHARACTER_MESSAGE_RENDERED', 'MESSAGE_UPDATED', 'MESSAGE_DELETED', 'MORE_MESSAGES_LOADED', 'MESSAGE_SWIPE_DELETED']) on(name, render);

const panel = document.createElement('div');
panel.className = 'stcc-settings';
panel.innerHTML = '<div class="inline-drawer"><div class="inline-drawer-toggle inline-drawer-header"><b>楼层 Token / 缓存统计</b><div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div></div><div class="inline-drawer-content"><label class="checkbox_label"><input type="checkbox" class="stcc-enabled"><span>启用逐楼层统计</span></label><p>采用 API 实际 usage；不估算缓存。用户楼层不单独计费，输入包含整个请求上下文。未知不代表 0。仅记录启用后的 Chat Completion 请求。</p><p>OpenAI 流式 usage 可能需通过自定义接口附加请求体启用：<code>stream_options: {include_usage: true}</code>。不支持该参数的中转站请勿设置。</p></div></div>';
const checkbox = panel.querySelector('input'); checkbox.checked = enabled();
checkbox.addEventListener('change', () => { settings[KEY].enabled = checkbox.checked; context().saveSettingsDebounced(); render(); });
document.querySelector('#extensions_settings2, #extensions_settings')?.append(panel);
// Rendering hooks may run before a newly inserted message is in the DOM.
let scheduled = false;
const chatElement = document.querySelector('#chat');
if (chatElement) new MutationObserver(mutations => {
    if (scheduled || !mutations.some(m => [...m.addedNodes].some(n => n.nodeType === 1 && (n.matches?.('.mes') || n.querySelector?.('.mes'))))) return;
    scheduled = true; queueMicrotask(() => { scheduled = false; render(); });
}).observe(chatElement, { childList: true, subtree: true });
render();
