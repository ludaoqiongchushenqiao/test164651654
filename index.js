/*
 * Compatibility patch for Story Oracle streaming through SillyTavern.
 *
 * SillyTavern's ChatCompletionService parses custom-source streams as
 * Anthropic-format when Chat Completion Cache is enabled. OpenAI-compatible
 * providers still return choices[0].delta.content, so the parser drops the
 * answer before Story Oracle can read chunk.text. For Oracle-only custom
 * streaming requests, translate content/reasoning to the parser's expected
 * text/thinking fields before the normal SillyTavern parser sees each event.
 *
 * A second, independent fallback handles non-primary choices exposed as
 * chunk.swipes after SillyTavern has parsed the stream.
 */
(() => {
    const host = typeof window !== 'undefined' ? window : globalThis;
    const PROCESS_MARK = '__storyOracleSwipeCompatV2';
    const FETCH_MARK = '__storyOracleSwipeFetchCompatV2';
    let synchronousOracleRequest = null;

    function isOracleCaller() {
        return (new Error().stack || '').includes('streamBackendForward');
    }

    function eligibleRequest(request) {
        return request?.stream === true && request?.chat_completion_source === 'custom';
    }

    function shouldTranslateCustomStream() {
        // This checkbox is the same global flag that SillyTavern's
        // getStreamingReply() consults before selecting its Anthropic parser.
        return host.document?.querySelector('#cc_cache_enabled')?.checked === true;
    }

    function rewriteSseLine(line) {
        const match = /^(\s*data:\s?)(.*?)(\r?)$/.exec(line);
        if (!match || !match[2] || match[2] === '[DONE]') return line;

        try {
            const event = JSON.parse(match[2]);
            const delta = event?.choices?.[0]?.delta;
            if (!delta || typeof delta !== 'object') return line;

            let changed = false;
            if (typeof delta.content === 'string' && typeof delta.text !== 'string') {
                delta.text = delta.content;
                changed = true;
            }
            if (typeof delta.reasoning === 'string' && typeof delta.thinking !== 'string') {
                delta.thinking = delta.reasoning;
                changed = true;
            } else if (typeof delta.reasoning_content === 'string' && typeof delta.thinking !== 'string') {
                delta.thinking = delta.reasoning_content;
                changed = true;
            }

            if (!changed) return line;
            return `${match[1]}${JSON.stringify(event)}${match[3]}`;
        } catch (_) {
            return line;
        }
    }

    function translateSseResponse(response) {
        if (!response?.body || typeof response.body.getReader !== 'function') return response;

        const decoder = new TextDecoder();
        const encoder = new TextEncoder();
        let buffer = '';
        const transformer = new (host.TransformStream || TransformStream)({
            transform(value, controller) {
                buffer += decoder.decode(value, { stream: true });
                const lines = buffer.split('\n');
                buffer = lines.pop() ?? '';
                if (lines.length) controller.enqueue(encoder.encode(lines.map(rewriteSseLine).join('\n') + '\n'));
            },
            flush(controller) {
                buffer += decoder.decode();
                if (buffer) controller.enqueue(encoder.encode(rewriteSseLine(buffer)));
            },
        });
        const body = response.body.pipeThrough(transformer);

        const headers = new Headers(response.headers);
        // Fetch has already decoded any content encoding; transformed bytes no
        // longer match a server-supplied Content-Length or Content-Encoding.
        headers.delete('content-length');
        headers.delete('content-encoding');
        return new Response(body, {
            status: response.status,
            statusText: response.statusText,
            headers,
        });
    }

    function installFetchHook() {
        const currentFetch = host.fetch;
        if (typeof currentFetch !== 'function') return false;
        if (currentFetch[FETCH_MARK]) return true;

        async function patchedFetch(input, init) {
            const active = synchronousOracleRequest;
            let payload = null;
            if (active && active.translate && init && typeof init.body === 'string') {
                try { payload = JSON.parse(init.body); } catch (_) { /* ignore */ }
            }

            const url = typeof input === 'string' ? input : input?.url;
            const isOracleCompletionRequest = Boolean(
                active?.translate &&
                payload?.stream === true &&
                payload?.chat_completion_source === 'custom' &&
                typeof url === 'string' && /\/api\/backends\/chat-completions\/generate(?:\?|$)/.test(url),
            );

            const response = await currentFetch.call(this, input, init);
            if (!isOracleCompletionRequest || !response.ok) return response;

            const contentType = response.headers?.get('content-type') || '';
            // Some hosted ST proxies omit Content-Type even though they return
            // the SSE framing consumed by EventSourceStream. Only reject an
            // explicit non-SSE response type.
            if (contentType && !/text\/event-stream/i.test(contentType)) return response;
            return translateSseResponse(response);
        }

        Object.defineProperty(patchedFetch, FETCH_MARK, { value: true });
        host.fetch = patchedFetch;
        return true;
    }

    function wrapOracleStream(result) {
        const makeIterator = typeof result === 'function'
            ? () => result()
            : result && typeof result[Symbol.asyncIterator] === 'function'
                ? () => result
                : null;
        if (!makeIterator) return result;

        return async function* oracleStreamWithSwipeFallback() {
            const pending = [];
            let primarySeen = false;
            let alternate = '';
            let lastChunk = null;

            for await (const chunk of makeIterator()) {
                lastChunk = chunk;
                if (Array.isArray(chunk?.swipes)) {
                    const candidate = chunk.swipes.find(text => typeof text === 'string' && text.trim());
                    if (candidate) alternate = candidate;
                }

                const hasPrimaryText = typeof chunk?.text === 'string' && chunk.text.trim().length > 0;
                if (primarySeen) {
                    yield chunk;
                } else if (hasPrimaryText) {
                    primarySeen = true;
                    yield* pending;
                    pending.length = 0;
                    yield chunk;
                } else {
                    pending.push(chunk);
                }
            }

            if (!primarySeen && alternate && lastChunk) {
                // Oracle treats text cumulatively, so don't replay buffered
                // empty chunks before the fallback.
                yield { ...lastChunk, text: alternate };
            } else if (!primarySeen) {
                yield* pending;
            }
        };
    }

    function install() {
        const service = host.SillyTavern?.getContext?.()?.ChatCompletionService;
        if (!service || typeof service.processRequest !== 'function') return false;
        if (service.processRequest[PROCESS_MARK]) return true;

        installFetchHook();
        const original = service.processRequest;
        async function patchedProcessRequest(...args) {
            const request = args[0];
            const isOracleCall = isOracleCaller();
            const isTarget = isOracleCall && eligibleRequest(request);
            if (!isTarget) return original.apply(this, args);

            // processRequest reaches fetch synchronously before its first await.
            // Capture only that request start; never keep a global "active" flag
            // while the model streams, which could affect unrelated traffic.
            const previous = synchronousOracleRequest;
            synchronousOracleRequest = {
                translate: shouldTranslateCustomStream(),
            };
            let pending;
            try {
                pending = original.apply(this, args);
            } finally {
                synchronousOracleRequest = previous;
            }

            const result = await pending;
            return wrapOracleStream(result);
        }

        Object.defineProperty(patchedProcessRequest, PROCESS_MARK, { value: true });
        service.processRequest = patchedProcessRequest;
        return true;
    }

    if (!install()) {
        let attempts = 0;
        const timer = setInterval(() => {
            attempts++;
            if (install() || attempts >= 40) clearInterval(timer);
        }, 250);
    }
})();

/*
 * Compatibility patch for Story Oracle streaming through SillyTavern.
 * SillyTavern stores non-primary chat choices in chunk.swipes. When the
 * primary choice is absent, Story Oracle's streamBackendForward only reads
 * chunk.text and otherwise ends up with an empty reply.
 */
(() => {
    const PATCH_MARK = '__storyOracleSwipeCompat';

    function install() {
        const service = SillyTavern?.getContext?.()?.ChatCompletionService;
        if (!service || typeof service.processRequest !== 'function') return false;
        if (service.processRequest[PATCH_MARK]) return true;

        const original = service.processRequest;
        async function patchedProcessRequest(...args) {
            const request = args[0];
            const isOracleCall = (new Error().stack || '').includes('streamBackendForward');
            const result = await original.apply(this, args);

            if (!isOracleCall || request?.stream !== true || request?.chat_completion_source !== 'custom') {
                return result;
            }

            const makeIterator = typeof result === 'function'
                ? () => result()
                : result && typeof result[Symbol.asyncIterator] === 'function'
                    ? () => result
                    : null;
            if (!makeIterator) return result;

            return async function* oracleStreamWithSwipeFallback() {
                const pending = [];
                let primarySeen = false;
                let alternate = '';
                let lastChunk = null;

                for await (const chunk of makeIterator()) {
                    lastChunk = chunk;
                    if (Array.isArray(chunk?.swipes)) {
                        const candidate = chunk.swipes.find(text => typeof text === 'string' && text.trim());
                        if (candidate) alternate = candidate;
                    }

                    const hasPrimaryText = typeof chunk?.text === 'string' && chunk.text.trim().length > 0;
                    if (primarySeen) {
                        yield chunk;
                    } else if (hasPrimaryText) {
                        primarySeen = true;
                        yield* pending;
                        pending.length = 0;
                        yield chunk;
                    } else {
                        pending.push(chunk);
                    }
                }

                if (!primarySeen && alternate && lastChunk) {
                    // Do not replay buffered empty chunks: Oracle treats text
                    // cumulatively, so the fallback must start from length 0.
                    yield { ...lastChunk, text: alternate };
                } else if (!primarySeen) {
                    yield* pending;
                }
            };
        }

        Object.defineProperty(patchedProcessRequest, PATCH_MARK, { value: true });
        service.processRequest = patchedProcessRequest;
        return true;
    }

    if (!install()) {
        let attempts = 0;
        const timer = setInterval(() => {
            attempts++;
            if (install() || attempts >= 40) clearInterval(timer);
        }, 250);
    }
})();
