const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const extensionSource = fs.readFileSync(path.join(__dirname, '..', 'index.js'), 'utf8');

function createHarness({ cacheEnabled = true, events, contentType = '' } = {}) {
    const responseEvents = events || [
        { choices: [{ index: 0, delta: { role: 'assistant' } }] },
        { choices: [{ index: 0, delta: { reasoning: 'thinking' } }] },
        { choices: [{ index: 0, delta: { content: 'OK' } }] },
        { choices: [{ index: 0, delta: {} }], usage: { completion_tokens: 2 } },
    ];
    const wire = responseEvents.map(event => `data: ${JSON.stringify(event)}\r\n\r\n`).join('') + 'data: [DONE]\r\n\r\n';
    const bytes = new TextEncoder().encode(wire);
    const cuts = [1, 7, 31, 67, 102];
    const chunks = [];
    let from = 0;
    for (const to of cuts) {
        if (to > from && to < bytes.length) {
            chunks.push(bytes.slice(from, to));
            from = to;
        }
    }
    if (from < bytes.length) chunks.push(bytes.slice(from));

    const settingsCheckbox = { checked: cacheEnabled };
    const host = {
        document: { querySelector: selector => selector === '#cc_cache_enabled' ? settingsCheckbox : null },
        TransformStream,
        fetch: async (_url, init) => {
            host.lastRequest = JSON.parse(init.body);
            let index = 0;
            const body = new ReadableStream({
                pull(controller) {
                    if (index >= chunks.length) return controller.close();
                    controller.enqueue(chunks[index++]);
                },
            });
            const headers = new Headers();
            if (contentType) headers.set('content-type', contentType);
            return new Response(body, { status: 200, headers });
        },
    };

    const service = {
        async processRequest(request) {
            const response = await host.fetch('/api/backends/chat-completions/generate', {
                method: 'POST',
                body: JSON.stringify(request),
            });
            return async function* streamData() {
                const reader = response.body.getReader();
                const decoder = new TextDecoder();
                let buffer = '';
                let text = '';
                while (true) {
                    const { value, done } = await reader.read();
                    if (done) break;
                    buffer += decoder.decode(value, { stream: true });
                    const lines = buffer.split('\n');
                    buffer = lines.pop() ?? '';
                    for (const line of lines) {
                        const match = /^data:\s?(.*)\r?$/.exec(line);
                        if (!match || match[1] === '[DONE]') continue;
                        const event = JSON.parse(match[1]);
                        const delta = event.choices?.[0]?.delta || {};
                        // Mimic ST's cache-enabled custom-source branch (expects
                        // Anthropic delta.text) versus its normal parser.
                        text += cacheEnabled ? (delta.text || '') : (delta.content || '');
                        yield { text, swipes: [], state: {} };
                    }
                }
            };
        },
    };
    host.SillyTavern = { getContext: () => ({ ChatCompletionService: service }) };

    const context = vm.createContext({
        window: host,
        globalThis: host,
        TextDecoder,
        TextEncoder,
        Headers,
        Response,
        ReadableStream,
        setInterval,
        clearInterval,
        console,
    });
    vm.runInContext(extensionSource, context, { filename: 'index.js' });
    context.streamBackendForward = function streamBackendForward(request) {
        return host.SillyTavern.getContext().ChatCompletionService.processRequest(request, {}, true, null);
    };
    context.ordinaryChatStream = function ordinaryChatStream(request) {
        return host.SillyTavern.getContext().ChatCompletionService.processRequest(request, {}, true, null);
    };
    return { host, context, service, settingsCheckbox };
}

async function collect(factory, request) {
    const iteratorFactory = await factory(request);
    const iterator = typeof iteratorFactory === 'function' ? iteratorFactory() : iteratorFactory;
    const chunks = [];
    for await (const chunk of iterator) chunks.push(chunk);
    return chunks;
}

const request = { stream: true, chat_completion_source: 'custom', model: 'fixture-model' };

test('recovers OpenAI delta.content for Oracle when the ST cache parser expects delta.text', async () => {
    const { context, host } = createHarness({ cacheEnabled: true });
    const chunks = await collect(context.streamBackendForward, request);
    assert.equal(chunks.at(-1).text, 'OK');
    assert.equal(host.lastRequest.chat_completion_source, 'custom');
});

test('leaves ordinary chat requests untouched', async () => {
    const { context } = createHarness({ cacheEnabled: true });
    const chunks = await collect(context.ordinaryChatStream, request);
    assert.equal(chunks.at(-1).text, '');
});

test('keeps the normal OpenAI parser path unchanged when cache is disabled', async () => {
    const { context } = createHarness({ cacheEnabled: false });
    const chunks = await collect(context.streamBackendForward, request);
    assert.equal(chunks.at(-1).text, 'OK');
});

test('does not rewrite an explicitly non-SSE response', async () => {
    const { context } = createHarness({ cacheEnabled: true, contentType: 'application/json' });
    const chunks = await collect(context.streamBackendForward, request);
    assert.equal(chunks.at(-1).text, '');
});

test('preserves already Anthropic-shaped text and maps reasoning to thinking', async () => {
    const { context } = createHarness({
        cacheEnabled: true,
        events: [
            { choices: [{ index: 0, delta: { text: 'OK', reasoning: 'reason' } }] },
        ],
    });
    const chunks = await collect(context.streamBackendForward, request);
    assert.equal(chunks.at(-1).text, 'OK');
});

test('falls back to the first non-empty alternate swipe', async () => {
    const { context, service } = createHarness({ cacheEnabled: false });
    service.processRequest = async function processRequestWithSwipe() {
        return async function* streamData() {
            yield { text: '', swipes: ['alternate answer'], state: {} };
        };
    };
    // Reinstall into the replacement service to exercise the swipe fallback.
    vm.runInContext(extensionSource, context, { filename: 'index-swipe.js' });
    const chunks = await collect(context.streamBackendForward, request);
    assert.equal(chunks.at(-1).text, 'alternate answer');
});

