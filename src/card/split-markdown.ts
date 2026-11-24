interface Fence {
  marker: string;
  opening: string;
}

/** Split serialized Markdown by bytes, preserving source characters and ordinary fenced blocks. */
export function splitMarkdown(text: string, maxBytes: number): string[] {
  if (maxBytes < 64) throw new RangeError('Markdown chunk budget must be at least 64 bytes');
  const chunks: string[] = [];
  let content = '';
  let bytes = 0;
  let hasSource = false;
  let fence: Fence | undefined;

  /** Close and reopen a fence around a boundary without emitting a wrapper-only chunk. */
  function flush(activeFence: Fence | undefined): void {
    if (!hasSource) return;
    chunks.push(content + (activeFence ? `${content.endsWith('\n') ? '' : '\n'}${activeFence.marker}` : ''));
    content = activeFence ? `${activeFence.opening}\n` : '';
    bytes = markdownBytes(content);
    hasSource = false;
  }

  for (const line of text.match(/[^\n]*\n|[^\n]+$/g) ?? []) {
    const nextFence = fenceAfterLine(line, fence, maxBytes);
    // Reserve closing syntax before appending source text. The opening fence
    // is bounded below, so a fresh chunk always has room for source characters.
    const reserve = Math.max(fence ? markdownBytes(`\n${fence.marker}`) : 0,
      nextFence ? markdownBytes(`\n${nextFence.marker}`) : 0);
    const openingOnly = fence && (content === `${fence.opening}\n` || content === `${fence.opening}\r\n`);
    if (hasSource && !openingOnly && bytes + markdownBytes(line) + reserve > maxBytes) flush(fence);
    for (const char of line) {
      const size = markdownBytes(char);
      // A long line must make progress too; for..of never cuts a Unicode pair.
      if (bytes + size + reserve > maxBytes) flush(fence);
      content += char;
      bytes += size;
      hasSource = true;
    }
    fence = nextFence;
  }
  flush(fence);
  return chunks;
}

/** Count JSON string content bytes, including escaping, without its enclosing quotes. */
function markdownBytes(text: string): number {
  return Buffer.byteLength(JSON.stringify(text), 'utf8') - 2;
}

/** Track backtick/tilde fences, retaining language tags such as c++ and longer markers. */
function fenceAfterLine(line: string, current: Fence | undefined, maxBytes: number): Fence | undefined {
  const opening = line.replace(/\r?\n$/, '');
  const match = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(opening);
  if (!match) return current;
  const marker = match[1]!;
  const info = match[2]!;
  if (current) {
    // Only a matching marker with no info closes an existing code block.
    return marker[0] === current.marker[0] && marker.length >= current.marker.length && !info.trim()
      ? undefined : current;
  }
  // Pathological fence headers remain source text instead of generating a
  // repeated prefix too large to fit. No source characters are removed.
  if ((marker[0] === '`' && info.includes('`'))
    || markdownBytes(opening) + markdownBytes(`\n${marker}`) > maxBytes / 2) return undefined;
  return { marker, opening };
}
