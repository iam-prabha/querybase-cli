import { remark } from "remark";

interface MdNode {
  type: string;
  depth?: number;
  value?: string;
  children?: MdNode[];
}

export interface MarkdownSection {
  headingPath: string;
  text: string;
}

const SPLIT_DEPTHS = new Set([1, 2]);

export function sectionMarkdown(markdown: string): MarkdownSection[] {
  const cleaned = stripMdx(frontmatterFree(markdown));
  const tree = remark().parse(cleaned) as unknown as MdNode;

  const sections: Array<{ headingPath: string[]; nodes: MdNode[] }> = [];
  let current: { headingPath: string[]; nodes: MdNode[] } | null = null;
  let h1 = "";

  const start = (path: string[], node: MdNode) => {
    current = { headingPath: path, nodes: [node] };
    sections.push(current);
  };
  const ensure = () => {
    if (!current) {
      current = { headingPath: [], nodes: [] };
      sections.push(current);
    }
    return current;
  };

  for (const node of tree.children ?? []) {
    if (node.type === "heading" && node.depth && SPLIT_DEPTHS.has(node.depth)) {
      const text = inlineText(node);
      if (node.depth === 1) {
        h1 = text;
        start([text], node);
      } else {
        start(h1 ? [h1, text] : [text], node);
      }
      continue;
    }
    ensure().nodes.push(node);
  }

  return sections.map((section) => ({
    headingPath: section.headingPath.join(" > "),
    text: serialize(section.nodes),
  }));
}

export function pageTitle(markdown: string): string | null {
  const match = frontmatterFree(markdown).match(/^#\s+(.+)$/m);
  return match ? match[1].trim() : null;
}

function inlineText(node: MdNode): string {
  return (node.children ?? [])
    .map((child) => child.value ?? "")
    .join("")
    .trim();
}

function serialize(nodes: MdNode[]): string {
  if (nodes.length === 0) return "";
  const root = { type: "root", children: nodes };
  return (remark().stringify(root as never) as string).trim();
}

function frontmatterFree(markdown: string): string {
  return markdown.replace(/^---[\s\S]*?---\n?/, "");
}

function stripMdx(markdown: string): string {
  const lines = markdown.split("\n");
  let inCode = false;
  const out: string[] = [];
  for (const line of lines) {
    if (/^\s*```/.test(line)) {
      inCode = !inCode;
      out.push(line);
      continue;
    }
    if (inCode) {
      out.push(line);
      continue;
    }
    let cleaned = line.replace(/\{\/\*[\s\S]*?\*\/\}/g, "");
    cleaned = cleaned.replace(/<\/?[A-Z][\w.]*(?:\s+[^<>]*?)?\/?>/g, "");
    out.push(cleaned);
  }
  return out.join("\n");
}
