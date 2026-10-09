// Observe bytes as SillyTavern consumes them: no duplicate request or background tee.
export function createSseParser(onPayload, onTerminal = () => {}) {
    let buffer = '';
    let pendingCR = false;
    function event(block) {
        const data = block.split('\n').filter(x => x.startsWith('data:')).map(x => x.slice(5).trimStart()).join('\n');
        if (!data) return;
        if (data.trim() === '[DONE]') { onTerminal(); return; }
        try { const payload = JSON.parse(data); onPayload(payload); if (payload.type === 'message_stop') onTerminal(); } catch { /* non-JSON heartbeat or isolated observer failure */ }
    }
    return {
        push(text) {
            text = (pendingCR ? '\r' : '') + text;
            pendingCR = text.endsWith('\r');
            if (pendingCR) text = text.slice(0, -1);
            buffer += text.replace(/\r\n|\r/g, '\n');
            let end;
            while ((end = buffer.indexOf('\n\n')) >= 0) {
                event(buffer.slice(0, end)); buffer = buffer.slice(end + 2);
            }
            // Protect against a malformed unbounded event; normal token events are tiny.
            if (buffer.length > 4 * 1024 * 1024) buffer = '';
        },
        finish() { if (pendingCR) { pendingCR = false; this.push('\n'); } if (buffer.trim()) event(buffer); buffer = ''; },
    };
}

export function observeResponse(response, onPayload, onFinish, { stream = false } = {}) {
    const payloadCallback = onPayload;
    const finishCallback = onFinish;
    onPayload = data => { try { payloadCallback(data); } catch (error) { console.warn('[ST Cache Counter] Usage observer failed', error); } };
    onFinish = success => { try { finishCallback(success); } catch (error) { console.warn('[ST Cache Counter] Usage completion observer failed', error); } };
    if (!response.ok) { onFinish(false); return response; }
    // ST forwardFetchResponse pipes bytes without forwarding upstream headers.
    // Use the actual request's stream flag, not Content-Type alone.
    if ((stream || (response.headers.get('content-type') || '').includes('text/event-stream')) && response.body) {
        const decoder = new TextDecoder();
        let failed = false;
        let finished = false;
        const finish = success => { if (!finished) { finished = true; onFinish(success && !failed); } };
        const parser = createSseParser(data => { if (data.error || data.type === 'error') failed = true; onPayload(data); }, () => finish(true));
        const reader = response.body.getReader();
        const body = new ReadableStream({
            async pull(controller) {
                try {
                    const { done, value } = await reader.read();
                    if (done) { parser.push(decoder.decode()); parser.finish(); finish(true); controller.close(); reader.releaseLock(); }
                    else { parser.push(decoder.decode(value, { stream: true })); controller.enqueue(value); }
                } catch (error) { finish(false); controller.error(error); reader.releaseLock(); }
            },
            async cancel(reason) { finish(false); try { await reader.cancel(reason); } finally { reader.releaseLock(); } },
        }, { highWaterMark: 0 });
        return new Response(body, { status: response.status, statusText: response.statusText, headers: response.headers });
    }
    const json = response.json.bind(response);
    response.json = async () => {
        try { const data = await json(); onPayload(data); onFinish(!data.error); return data; }
        catch (error) { onFinish(false); throw error; }
    };
    return response;
}
