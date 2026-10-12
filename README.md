# Story Oracle streaming compatibility patch

This SillyTavern extension fixes blank replies from Story Oracle when both of these apply:

- Story Oracle sends a streaming request through SillyTavern's custom chat-completion source.
- SillyTavern's **Chat Completion Cache** is enabled, so its response parser expects Anthropic-style `delta.text` while an OpenAI-compatible endpoint returns `choices[0].delta.content`.

The patch keeps a request-specific marker through SillyTavern's asynchronous preset preparation, then translates that one response before the normal parser sees it. It reinstalls its fetch adapter immediately before each matching Oracle request, because another Tavern extension can replace the global `fetch` hook after startup. It also maps reasoning metadata for Story Oracle's live-output view and retains a fallback for non-primary choices exposed through `chunk.swipes`. Unrelated requests pass through unchanged.

## Install or update

In SillyTavern, open **Extensions → Install extension** and enter:

`https://github.com/ludaoqiongchushenqiao/test164651654`

If the extension is already installed, use **Manage extensions** to update it or reinstall it, then refresh the SillyTavern page so the new JavaScript loads. Keep the original Story Oracle extension enabled; this patch supplements it.

## Diagnosis and limits

The reproduced failure had HTTP 200 and a valid SSE `choices[0].delta.content` answer, but SillyTavern's cache parser reads top-level `delta.text` and `delta.thinking`. Version 1.4.0 maps those fields at the expected top level, keeps a request-specific marker through asynchronous preset preparation, matches it to the outgoing model/messages, and reattaches its fetch adapter for each Oracle call in case another extension replaced it. If the provider truly sends no answer text, no client-side adapter can reconstruct one; Story Oracle should continue to show its empty-response notice.

To roll back, disable or uninstall this compatibility extension. It does not change SillyTavern settings or the Story Oracle source files.

