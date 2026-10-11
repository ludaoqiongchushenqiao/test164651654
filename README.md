# Story Oracle streaming compatibility patch

This SillyTavern extension fixes blank replies from Story Oracle when both of these apply:

- Story Oracle sends a streaming request through SillyTavern's custom chat-completion source.
- SillyTavern's **Chat Completion Cache** is enabled, so its response parser expects Anthropic-style `delta.text` while an OpenAI-compatible endpoint returns `choices[0].delta.content`.

The patch keeps a request-specific marker through SillyTavern's asynchronous preset preparation, then translates that one response before the normal parser sees it. It also maps reasoning metadata for Story Oracle's live-output view and retains a fallback for non-primary choices exposed through `chunk.swipes`. Unrelated requests pass through unchanged.

## Install or update

In SillyTavern, open **Extensions → Install extension** and enter:

`https://github.com/ludaoqiongchushenqiao/test164651654`

If the extension is already installed, use **Manage extensions** to update it or reinstall it, then refresh the SillyTavern page so the new JavaScript loads. Keep the original Story Oracle extension enabled; this patch supplements it.

## Diagnosis and limits

The reproduced failure had HTTP 200 and a valid SSE `delta.content` answer, but SillyTavern parsed every chunk as empty because Chat Completion Cache was enabled. The first patch missed the fetch because SillyTavern awaited preset preparation before sending it; version 1.2.0 keeps a request-specific marker through that asynchronous step and matches it to the outgoing model/messages. If the provider truly sends no answer text, no client-side adapter can reconstruct one; Story Oracle should continue to show its empty-response notice.

To roll back, disable or uninstall this compatibility extension. It does not change SillyTavern settings or the Story Oracle source files.

