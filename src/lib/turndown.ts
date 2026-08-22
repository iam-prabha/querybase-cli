import TurndownService from "turndown";

export const turndown = new TurndownService({
  codeBlockStyle: "fenced",
  headingStyle: "atx",
});

export function toMarkdown(body: string): string {
  if (looksLikeHtml(body)) {
    return turndown.turndown(body);
  }
  return body;
}

function looksLikeHtml(body: string): boolean {
  return /<html[\s>]|<body[\s>]|<!DOCTYPE/i.test(body);
}