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

    function requestSignature(request) {
        try {
            return JSON.stringify([
                request?.model,
                request?.chat_completion_source,
                request?.custom_url,
                request?.messages,
            ]);
        } catch (_) {
            return null;
        }
    }

    function shouldTranslateCustomStream() {
        // This checkbox is the same global flag that SillyTavern's
        // getStreamingReply() consults before selecting its Anthropic parser.
        return host.document?.querySelector('#cc_cache_enabled')?.checked === true;
    }

    function isOracleCorrectionRequest(request) {
        const messages = Array.isArray(request?.messages) ? request.messages : [];
        return messages.some(message => {
            const content = typeof message?.content === 'string' ? message.content : '';
            return /<text_to_transform\b/i.test(content) && /<FixedReply\b/i.test(content);
        });
    }

    function needsFixedReplyClosure(text) {
        return /<FixedReply\b/i.test(text) && !/<\/FixedReply\s*>/i.test(text);
    }

    function makeFixedReplyClosureEvent(translate) {
        const text = '</FixedReply>';
        const event = { choices: [{ index: 0, delta: { content: text } }] };
        if (translate) event.delta = { text };
        return `data: ${JSON.stringify(event)}`;
    }

    function isNaturalFinish(reason) {
        return /^(stop|end_turn|completed)$/i.test(String(reason || ''));
    }

    function rewriteSseLine(line, options, state) {
        const match = /^(\s*data:\s?)(.*?)(\r?)$/.exec(line);
        if (!match || !match[2]) return line;

        if (match[2] === '[DONE]') {
            state.doneSeen = true;
            if (options.repairFixEnvelope && isNaturalFinish(state.finishReason) && needsFixedReplyClosure(state.content)) {
                state.repaired = true;
                return `${makeFixedReplyClosureEvent(options.translate)}\r\n\r\n${line}`;
            }
            return line;
        }

        try {
            const event = JSON.parse(match[2]);
            const choice = event?.choices?.[0];
            const choiceDelta = event?.choices?.[0]?.delta;
            if (choice?.finish_reason) state.finishReason = String(choice.finish_reason);
            if (options.repairFixEnvelope && choice?.index !== 1 && typeof choiceDelta?.content === 'string') {
                state.content += choiceDelta.content;
            }
            if (!options.translate || !choiceDelta || typeof choiceDelta !== 'object') return line;

            if (!event.delta || typeof event.delta !== 'object') {
                event.delta = {};
            }

            let changed = false;
            if (typeof choiceDelta.content === 'string' && typeof event.delta.text !== 'string') {
                event.delta.text = choiceDelta.content;
                changed = true;
            }
            if (typeof choiceDelta.reasoning === 'string' && typeof event.delta.thinking !== 'string') {
                event.delta.thinking = choiceDelta.reasoning;
                changed = true;
            } else if (typeof choiceDelta.reasoning_content === 'string' && typeof event.delta.thinking !== 'string') {
                event.delta.thinking = choiceDelta.reasoning_content;
                changed = true;
            }

            if (!changed) return line;
            return `${match[1]}${JSON.stringify(event)}${match[3]}`;
        } catch (_) {
            return line;
        }
    }

    function translateSseResponse(response, options) {
        if (!response?.body || typeof response.body.getReader !== 'function') return response;

        const decoder = new TextDecoder();
        const encoder = new TextEncoder();
        const state = { content: '', finishReason: '', doneSeen: false, repaired: false };
        let buffer = '';
        const transformer = new (host.TransformStream || TransformStream)({
            transform(value, controller) {
                buffer += decoder.decode(value, { stream: true });
                const lines = buffer.split('\n');
                buffer = lines.pop() ?? '';
                if (lines.length) controller.enqueue(encoder.encode(lines.map(line => rewriteSseLine(line, options, state)).join('\n') + '\n'));
            },
            flush(controller) {
                buffer += decoder.decode();
                if (buffer) controller.enqueue(encoder.encode(rewriteSseLine(buffer, options, state)));
                if (options.repairFixEnvelope && !state.repaired && isNaturalFinish(state.finishReason) && needsFixedReplyClosure(state.content)) {
                    controller.enqueue(encoder.encode(`${makeFixedReplyClosureEvent(options.translate)}\r\n\r\n`));
                }
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
            if (active && (active.translate || active.repairFixEnvelope) && init && typeof init.body === 'string') {
                try { payload = JSON.parse(init.body); } catch (_) { /* ignore */ }
            }

            const url = typeof input === 'string' ? input : input?.url;
            const isOracleCompletionRequest = Boolean(
                active && (active.translate || active.repairFixEnvelope) &&
                payload?.stream === true &&
                payload?.chat_completion_source === 'custom' &&
                active.signature !== null &&
                requestSignature(payload) === active.signature &&
                typeof url === 'string' && /\/api\/backends\/chat-completions\/generate(?:\?|$)/.test(url),
            );

            // Consume the one-request marker before awaiting network I/O, so a
            // concurrent custom chat cannot inherit this Oracle request's scope.
            if (isOracleCompletionRequest && synchronousOracleRequest === active) {
                synchronousOracleRequest = active.previous;
            }

            const response = await currentFetch.call(this, input, init);
            if (!isOracleCompletionRequest || !response.ok) return response;

            const contentType = response.headers?.get('content-type') || '';
            // Some hosted ST proxies omit Content-Type even though they return
            // the SSE framing consumed by EventSourceStream. Only reject an
            // explicit non-SSE response type.
            if (contentType && !/text\/event-stream/i.test(contentType)) return response;
            return translateSseResponse(response, {
                translate: active.translate,
                repairFixEnvelope: active.repairFixEnvelope,
            });
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

            // Other Tavern extensions can replace window.fetch after this
            // extension loads. Re-wrap the current fetch immediately before
            // the Oracle request so the compatibility transform remains in
            // the active request chain.
            installFetchHook();

            const previous = synchronousOracleRequest;
            const active = {
                translate: shouldTranslateCustomStream(),
                repairFixEnvelope: isOracleCorrectionRequest(request),
                signature: requestSignature(request),
                previous,
            };
            synchronousOracleRequest = active;
            let result;
            try {
                // ChatCompletionService.processRequest awaits preset and payload
                // preparation before sendRequest reaches fetch. Keep the marker
                // through that work, then clear it once the matching fetch starts.
                result = await original.apply(this, args);
            } finally {
                if (synchronousOracleRequest === active) {
                    synchronousOracleRequest = previous;
                }
            }
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

