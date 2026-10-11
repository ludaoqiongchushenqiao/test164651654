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
