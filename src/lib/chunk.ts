const CHARS_PER_TOKEN = 2.0;

export function chunkText(text: string, maxTokens: number): string[] {
  const maxChars = Math.floor(maxTokens * CHARS_PER_TOKEN);
  const chunks: string[] = [];
  const paragraphs = text.split(/\n\s*\n/);
  let buffer = "";
  const flush = () => {
    if (buffer.trim().length > 0) chunks.push(buffer.trim());
    buffer = "";
  };

  for (const raw of paragraphs) {
    const paragraph = raw.trim();
    if (paragraph.length === 0) continue;
    if (paragraph.length <= maxChars) {
      if ((buffer + "\n\n" + paragraph).length <= maxChars) {
        buffer = buffer.length > 0 ? buffer + "\n\n" + paragraph : paragraph;
      } else {
        flush();
        buffer = paragraph;
      }
      continue;
    }
    flush();
    let rest = paragraph;
    while (rest.length > maxChars) {
      let cut = rest.lastIndexOf(" ", maxChars);
      if (cut < maxChars * 0.6) cut = maxChars;
      chunks.push(rest.slice(0, cut).trim());
      rest = rest.slice(cut).trim();
    }
    buffer = rest;
  }
  flush();
  return chunks;
}