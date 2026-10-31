/**
 * AST node and token types for the TRAME Collaborative Wiki Markdown Parser
 * adhering to docs/specs/e5-collaborative-wiki-notes-ui-hando.md.
 */

export type NoteVisibility = "PRIVATE" | "PARTY" | "DM_ONLY";
export type UserRole = "GameMaster" | "Player" | "Spectator";
export type NoteAccessDecision = "OK" | "FORBIDDEN" | "NOT_FOUND";

export interface NoteAccessQuery {
  visibility: NoteVisibility;
  ownerUserId: string;
  requestingUserId: string;
  requestingUserRole: UserRole;
  isWrite?: boolean;
}

export function evaluateNoteAccess(query: NoteAccessQuery): NoteAccessDecision {
  if (query.visibility === "PRIVATE") {
    return query.ownerUserId === query.requestingUserId ? "OK" : "NOT_FOUND";
  }
  if (query.visibility === "DM_ONLY") {
    return query.requestingUserRole === "GameMaster" ? "OK" : "FORBIDDEN";
  }
  if (query.visibility === "PARTY") {
    if (query.isWrite && query.requestingUserRole === "Spectator") {
      return "FORBIDDEN";
    }
    return "OK";
  }
  return "NOT_FOUND";
}

export interface WikiLinkToken {
  type: "wikilink";
  target: string;
  label: string;
  raw: string;
}

export interface HandoutBlockNode {
  type: "handout";
  id: string;
  title: string;
  revealed: boolean;
  content: string;
  raw: string;
}

export interface DmBlockNode {
  type: "dm";
  content: string;
  raw: string;
}

export interface TextBlockNode {
  type: "text";
  content: string;
}

export type WikiAstNode = HandoutBlockNode | DmBlockNode | TextBlockNode;

export interface ParsedWikiDocument {
  ast: WikiAstNode[];
  wikilinks: WikiLinkToken[];
  handouts: HandoutBlockNode[];
  dmBlocks: DmBlockNode[];
}

/**
 * Parses `[[Entity]]` or `[[Entity|Custom Label]]` wikilinks from raw text.
 */
export function extractWikilinks(text: string): WikiLinkToken[] {
  const regex = /\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g;
  const tokens: WikiLinkToken[] = [];
  let match: RegExpExecArray | null;

  while ((match = regex.exec(text)) !== null) {
    const target = match[1].trim();
    const label = match[2] ? match[2].trim() : target;
    tokens.push({
      type: "wikilink",
      target,
      label,
      raw: match[0],
    });
  }

  return tokens;
}

/**
 * Parses key-value attributes from `:::handout{id="..." title="..." revealed="..."}`
 */
function parseDirectiveAttributes(header: string): Record<string, string> {
  const attrs: Record<string, string> = {};
  const start = header.indexOf("{");
  const end = header.lastIndexOf("}");
  if (start === -1 || end === -1 || end <= start) {
    return attrs;
  }
  const inner = header.slice(start + 1, end);
  const attrRegex = /(\w+)=(["'])(.*?)\2/g;
  let match: RegExpExecArray | null;
  while ((match = attrRegex.exec(inner)) !== null) {
    attrs[match[1]] = match[3];
  }
  return attrs;
}

/**
 * Parses a raw wiki markdown document into an AST with typed directive blocks and wikilinks.
 */
export function parseWikiMarkdown(rawMarkdown: string): ParsedWikiDocument {
  const lines = rawMarkdown.split("\n");
  const ast: WikiAstNode[] = [];
  const wikilinks = extractWikilinks(rawMarkdown);
  const handouts: HandoutBlockNode[] = [];
  const dmBlocks: DmBlockNode[] = [];

  let currentTextLines: string[] = [];
  let i = 0;

  const flushText = () => {
    if (currentTextLines.length > 0) {
      ast.push({
        type: "text",
        content: currentTextLines.join("\n"),
      });
      currentTextLines = [];
    }
  };

  while (i < lines.length) {
    const line = lines[i];
    const trimmed = line.trim();

    if (trimmed === ":::dm") {
      flushText();
      const blockRawLines = [line];
      const contentLines: string[] = [];
      i++;
      while (i < lines.length) {
        const inner = lines[i];
        blockRawLines.push(inner);
        if (inner.trim() === ":::") {
          i++;
          break;
        }
        contentLines.push(inner);
        i++;
      }
      const dmNode: DmBlockNode = {
        type: "dm",
        content: contentLines.join("\n"),
        raw: blockRawLines.join("\n"),
      };
      ast.push(dmNode);
      dmBlocks.push(dmNode);
      continue;
    }

    if (trimmed.startsWith(":::handout")) {
      flushText();
      const attrs = parseDirectiveAttributes(trimmed);
      const blockRawLines = [line];
      const contentLines: string[] = [];
      i++;
      while (i < lines.length) {
        const inner = lines[i];
        blockRawLines.push(inner);
        if (inner.trim() === ":::") {
          i++;
          break;
        }
        contentLines.push(inner);
        i++;
      }
      const handoutNode: HandoutBlockNode = {
        type: "handout",
        id: attrs.id || "",
        title: attrs.title || "Handout",
        revealed: attrs.revealed === "true",
        content: contentLines.join("\n"),
        raw: blockRawLines.join("\n"),
      };
      ast.push(handoutNode);
      handouts.push(handoutNode);
      continue;
    }

    currentTextLines.push(line);
    i++;
  }

  flushText();

  return {
    ast,
    wikilinks,
    handouts,
    dmBlocks,
  };
}

/**
 * Filters a wiki document for client display:
 * - GameMaster sees all content.
 * - Non-GM has all `:::dm` blocks and unrevealed `:::handout` blocks removed.
 */
export function filterWikiMarkdownForRole(rawMarkdown: string, isGameMaster: boolean): string {
  if (isGameMaster) {
    return rawMarkdown;
  }
  const parsed = parseWikiMarkdown(rawMarkdown);
  const output: string[] = [];

  for (const node of parsed.ast) {
    if (node.type === "text") {
      output.push(node.content);
    } else if (node.type === "handout") {
      if (node.revealed) {
        output.push(node.raw);
      }
    } else if (node.type === "dm") {
      // Purged completely
    }
  }

  return output.join("\n");
}

/**
 * Escapes HTML special characters (`&`, `<`, `>`, `"`, `'`) to prevent XSS injection
 * when interpolating user-supplied wiki targets and labels into DOM markup.
 */
function escapeHtml(raw: string): string {
  return raw
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/**
 * Replaces `[[Entity]]` wikilinks with styled anchors/spans for preview rendering.
 */
export function renderWikiLinksToHtml(text: string): string {
  return text.replace(/\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g, (_match, target, label) => {
    const linkTarget = escapeHtml((target as string).trim());
    const linkLabel = escapeHtml(label ? (label as string).trim() : (target as string).trim());
    return `<a class="wiki-entity-link" href="#entity/${linkTarget}" data-entity="${linkTarget}">${linkLabel}</a>`;
  });
}
