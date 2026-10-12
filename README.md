# Story Oracle streaming compatibility patch

This SillyTavern extension fixes blank replies from Story Oracle when both of these apply:

- Story Oracle sends a streaming request through SillyTavern's custom chat-completion source.
- SillyTavern's **Chat Completion Cache** is enabled, so its response parser expects Anthropic-style `delta.text` while an OpenAI-compatible endpoint returns `choices[0].delta.content`.

The patch keeps a request-specific marker through SillyTavern's asynchronous preset preparation, then translates that one response before the normal parser sees it. It reinstalls its fetch adapter immediately before each matching Oracle request, because another Tavern extension can replace the global `fetch` hook after startup. It also maps reasoning metadata for Story Oracle's live-output view and retains a fallback for non-primary choices exposed through `chunk.swipes`. Unrelated requests pass through unchanged.

For Oracle correction requests, SillyTavern's streaming profile API drops the provider's `finish_reason` before Story Oracle receives the text. When the provider explicitly ends normally (`stop`, `end_turn`, or `completed`) but the generated `<FixedReply>` envelope is missing its closing tag, the patch adds that one closing tag to the stream. This lets Story Oracle parse and preview/apply the returned correction instead of falsely reporting a token-limit truncation. A response marked `length` is left untouched, as are ordinary chat requests and non-correction Oracle requests.

## Install or update

In SillyTavern, open **Extensions → Install extension** and enter:

`https://github.com/ludaoqiongchushenqiao/test164651654`

If the extension is already installed, use **Manage extensions** to update it or reinstall it, then refresh the SillyTavern page so the new JavaScript loads. Keep the original Story Oracle extension enabled; this patch supplements it.

## Diagnosis and limits

The reproduced blank-response failure had HTTP 200 and valid SSE `choices[0].delta.content`, but SillyTavern's cache parser reads top-level `delta.text` and `delta.thinking`. The patch maps those fields at the expected top level and reattaches its fetch adapter for each matching Oracle call. A second observed issue was a normally completed correction stream with an unclosed `<FixedReply>` wrapper; Story Oracle's wrapper heuristic mislabeled it as token truncation. Version 1.5.0 repairs only that wrapper on an explicit normal finish. If the provider truly sends no answer text, or reports a length cutoff, the adapter does not invent a correction.

To roll back, disable or uninstall this compatibility extension. It does not change SillyTavern settings or the Story Oracle source files.

