# Story Oracle Swipe Compatibility Patch

This small SillyTavern extension patches only Story Oracle calls that use the custom chat-completion source and streaming. It buffers empty chunks until the primary reply appears. If the stream ends without primary text but contains a non-empty alternate in `chunk.swipes`, it supplies that alternate as the cumulative `chunk.text` reply.

## Install through SillyTavern

SillyTavern's extension installer accepts a Git repository URL, not a local JavaScript or ZIP file. Put this folder at the root of a Git repository that the SillyTavern server can access, then use **Extensions → Install extension** and enter that repository URL. In a multi-user server, install to the current user if that option is available.

The manifest loads this patch after Story Oracle (`loading_order: 110`, Oracle uses 100). Refresh the browser after installation.

## Scope and rollback

The patch wraps the chat completion stream only when the caller is Story Oracle, streaming is enabled, and the source is `custom`. Normal chat requests and other providers pass through unchanged. To roll back, disable or uninstall this extension.
