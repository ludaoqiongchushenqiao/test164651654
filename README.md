# Story Oracle streaming compatibility patch

This SillyTavern extension fixes blank replies from Story Oracle when both of these apply:

- Story Oracle sends a streaming request through SillyTavern's custom chat-completion source.
- SillyTavern's **Chat Completion Cache** is enabled, so its response parser expects Anthropic-style `delta.text` while an OpenAI-compatible endpoint returns `choices[0].delta.content`.

The patch translates the response only for Story Oracle's own custom streaming calls, before SillyTavern parses the stream. It also maps reasoning metadata for Story Oracle's live-output view and retains a fallback for non-primary choices exposed through `chunk.swipes`. Other chat requests and providers pass through unchanged.

## Install or update

In SillyTavern, open **Extensions → Install extension** and enter:

`https://github.com/ludaoqiongchushenqiao/test164651654`

If the extension is already installed, use **Manage extensions** to update it or reinstall it, then refresh the SillyTavern page so the new JavaScript loads. Keep the original Story Oracle extension enabled; this patch supplements it.

## Diagnosis and limits

The reproduced failure had HTTP 200 and a valid SSE `delta.content` answer, but SillyTavern parsed every chunk as empty because Chat Completion Cache was enabled. This patch addresses that response-shape mismatch. If the provider truly sends no answer text, no client-side adapter can reconstruct one; Story Oracle should continue to show its empty-response notice.

To roll back, disable or uninstall this compatibility extension. It does not change SillyTavern settings or the Story Oracle source files.

# Story Oracle Swipe Compatibility Patch

This small SillyTavern extension patches only Story Oracle calls that use the custom chat-completion source and streaming. It buffers empty chunks until the primary reply appears. If the stream ends without primary text but contains a non-empty alternate in `chunk.swipes`, it supplies that alternate as the cumulative `chunk.text` reply.

## Install through SillyTavern

SillyTavern's extension installer accepts a Git repository URL, not a local JavaScript or ZIP file. Put this folder at the root of a Git repository that the SillyTavern server can access, then use **Extensions → Install extension** and enter that repository URL. In a multi-user server, install to the current user if that option is available.

The manifest loads this patch after Story Oracle (`loading_order: 110`, Oracle uses 100). Refresh the browser after installation.

## Scope and rollback

The patch wraps the chat completion stream only when the caller is Story Oracle, streaming is enabled, and the source is `custom`. Normal chat requests and other providers pass through unchanged. To roll back, disable or uninstall this extension.
