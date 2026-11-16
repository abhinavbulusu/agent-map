/**
 * live/sse.ts — parse Server-Sent Events.
 *
 * SSE is a dead-simple streaming format over a normal HTTP response with
 * `Content-Type: text/event-stream`. The body is text, made of MESSAGES
 * separated by a blank line. Each message is a few "field: value" lines:
 *
 *     event: content_block_delta          ← optional message type
 *     data: {"type":"content_block_delta","delta":{"text":"Hel"}}
 *                                          ← blank line = dispatch this message
 *     data: {"choices":[{"delta":{"content":"lo"}}]}
 *
 *     data: [DONE]                         ← OpenAI's end-of-stream marker
 *
 * Rules from the spec: multiple `data:` lines in one message are joined with
 * "\n"; one leading space after the colon is dropped; lines starting with ":"
 * are comments (servers send them as keep-alives); line endings may be
 * \n, \r\n or \r.
 *
 * LLM APIs use SSE so the client can show tokens as they're generated. The
 * browser view uses SSE too (server → browser live updates): same format.
 */
export interface SseMessage {
  event?: string;
  data: string;
  id?: string;
}

export function parseSse(text: string): SseMessage[] {
  const messages: SseMessage[] = [];
  let event: string | undefined;
  let id: string | undefined;
  let data: string[] = [];

  const dispatch = () => {
    if (data.length > 0) {
      const msg: SseMessage = { data: data.join("\n") };
      if (event !== undefined) msg.event = event;
      if (id !== undefined) msg.id = id;
      messages.push(msg);
    }
    event = undefined;
    data = [];
  };

  for (const line of text.split(/\r\n|\r|\n/)) {
    if (line === "") {
      dispatch();
      continue;
    }
    if (line.startsWith(":")) continue; // comment / keep-alive
    const colon = line.indexOf(":");
    const field = colon === -1 ? line : line.slice(0, colon);
    let value = colon === -1 ? "" : line.slice(colon + 1);
    if (value.startsWith(" ")) value = value.slice(1);
    if (field === "data") data.push(value);
    else if (field === "event") event = value;
    else if (field === "id") id = value;
    // "retry" and unknown fields are ignored.
  }
  dispatch(); // a stream may end without the final blank line
  return messages;
}

/** Format one message for sending (used by the UI server). */
export function formatSse(data: string, event?: string): string {
  const lines = data.split("\n").map((l) => `data: ${l}`);
  return (event ? `event: ${event}\n` : "") + lines.join("\n") + "\n\n";
}
