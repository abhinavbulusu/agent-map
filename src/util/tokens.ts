/**
 * Token estimation.
 *
 * LLMs don't read characters, they read TOKENS: chunks produced by a
 * tokenizer (usually BPE, "byte-pair encoding", which merges frequent
 * character sequences into single tokens). For English prose a token averages
 * about 4 characters. JSON, code, URLs and base64 tokenize WORSE (more tokens
 * per character), because their character sequences are less "word-like".
 *
 * Why estimate instead of using a real tokenizer library?
 *  - Every model family has its own tokenizer (OpenAI's o200k, Anthropic's,
 *    Llama's, ...). A real count would need one dependency per family.
 *  - Our questions are coarse: "is this tool response > 20k tokens?" and
 *    "which part of the prompt is eating the context window?" A ±20% estimate
 *    answers both.
 *  - For the TOTAL, providers report the exact number in `usage`; the context
 *    X-ray shows both, so you can see how close the estimate is.
 */
export function estimateTokens(text: string): number {
  if (text.length === 0) return 0;
  return Math.ceil(text.length / 4);
}

/** Format 12345 → "12,345" for display. */
export function formatTokens(n: number): string {
  return n.toLocaleString("en-US");
}
