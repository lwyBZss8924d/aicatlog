import { basename } from 'node:path';
import { AicatlogError, type ContextInspection, type ContextSection, type Resource } from './types.ts';

type Profile = Pick<ContextInspection, 'document_role' | 'context_format' | 'classification'>;
type Inspection = Pick<ContextInspection, 'title' | 'summary' | 'sections' | 'references' | 'diagnostics' | 'valid'>;

export function contextProfile(resource: Resource): Profile | undefined {
  const role = resource.document_role, format = resource.context_format;
  if (role && !['context_index', 'prompt_context'].includes(role)) return undefined;
  if (role || format) {
    if (format && !['llms-txt-v2', 'markdown'].includes(format))
      throw new AicatlogError('UNSUPPORTED_CONTEXT_FORMAT', `Unsupported context_format ${format}; use llms-txt-v2 or markdown for context resources.`);
    const document_role = role ?? (format === 'llms-txt-v2' ? 'context_index' : 'prompt_context');
    const context_format = format ?? (document_role === 'context_index' ? 'llms-txt-v2' : 'markdown');
    if ((document_role === 'context_index') !== (context_format === 'llms-txt-v2'))
      throw new AicatlogError('CONTEXT_DECLARATION_CONFLICT', 'context_index requires llms-txt-v2; prompt_context requires markdown.');
    return { document_role, context_format, classification: 'declared' } as Profile;
  }
  if (resource.path && basename(resource.path) === 'llms.txt')
    return { document_role: 'context_index', context_format: 'llms-txt-v2', classification: 'filename' };
  return undefined;
}

// This is a bounded local Markdown scanner, not a renderer or a link expander.
function headingSlug(label: string): string {
  return label.toLowerCase().replace(/[^\p{L}\p{N}\p{M}_\-\s]/gu, '').trim().replace(/\s/g, '-');
}
type Heading = ContextSection & { heading_end: number };
function scan(lines: string[]) {
  const headings: Heading[] = [], code = new Set<number>();
  let fence: { marker: string; length: number } | undefined;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (fence) {
      code.add(i);
      const close = /^ {0,3}(`+|~+)[ \t]*$/.exec(line);
      if (close && close[1]![0] === fence.marker && close[1]!.length >= fence.length) fence = undefined;
      continue;
    }
    const opening = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
    if (opening && !(opening[1]![0] === '`' && opening[2]!.includes('`'))) {
      fence = { marker: opening[1]![0]!, length: opening[1]!.length }; code.add(i); continue;
    }
    if (/^(?: {4}|\t)/.test(line)) { code.add(i); continue; }
    const atx = /^ {0,3}(#{1,6})(?:[ \t]+(.*)|[ \t]*)$/.exec(line);
    const underline = i + 1 < lines.length && /^ {0,3}(=+|-+)[ \t]*$/.exec(lines[i + 1]!);
    const setext = !atx && line.trim() && !/^ {0,3}(?:[>#]|[-+*][ \t]|\d+[.)][ \t])/.test(line) && underline;
    if (!atx && !setext) continue;
    const label = atx ? (atx[2] ?? '').replace(/[ \t]+#+[ \t]*$/, '').trim() : line.trim();
    const level = atx ? atx[1]!.length : (underline && underline[1]![0] === '=' ? 1 : 2);
    headings.push({ selector: `heading:${i + 1}`, slug: headingSlug(label), label, level,
      start_line: i + 1, heading_end: i + (setext ? 2 : 1), end_line: lines.length });
    if (setext) i++;
  }
  for (const [index, heading] of headings.entries()) {
    const next = headings.slice(index + 1).find(next => next.level <= heading.level);
    heading.end_line = next ? next.start_line - 1 : lines.length;
  }
  return { headings, code };
}

type Link = { label: string; target: string; start: number; end: number };
const unescape = (value: string) => value.replace(/\\([!"#$%&'()*+,\-./:;<=>?@[\]\\^_`{|}~])/g, '$1');
function inlineLinks(line: string): Link[] {
  const result: Link[] = [];
  for (let i = 0; i < line.length; i++) {
    if (line[i] === '\\') { i++; continue; }
    if (line[i] === '`') {
      let length = 1; while (line[i + length] === '`') length++;
      const closing = line.indexOf('`'.repeat(length), i + length);
      i = closing < 0 ? i + length - 1 : closing + length - 1; continue;
    }
    if (line[i] !== '[' || line[i - 1] === '!') continue;
    let j = i + 1, depth = 1;
    for (; j < line.length && depth; j++) {
      if (line[j] === '\\') { j++; continue; }
      if (line[j] === '[') depth++;
      if (line[j] === ']') depth--;
    }
    if (depth || line[j] !== '(') continue;
    const label = line.slice(i + 1, j - 1); j++;
    while (/[ \t]/.test(line[j] ?? '') && j < line.length) j++;
    const begin = j; let target = '';
    if (line[j] === '<') {
      j++;
      while (j < line.length && line[j] !== '>') { if (line[j] === '\\') j++; j++; }
      if (line[j] !== '>') continue;
      target = line.slice(begin + 1, j++);
    } else {
      depth = 0;
      while (j < line.length) {
        if (line[j] === '\\') { j += 2; continue; }
        if (line[j] === '(') depth++;
        if (line[j] === ')') { if (!depth) break; depth--; }
        if (/[ \t]/.test(line[j]!)) break;
        j++;
      }
      if (depth) continue;
      target = line.slice(begin, j);
    }
    while (j < line.length && /[ \t]/.test(line[j]!)) j++;
    if (['"', "'"].includes(line[j] ?? '')) {
      const quote = line[j++]!;
      while (j < line.length && line[j] !== quote) { if (line[j] === '\\') j++; j++; }
      if (line[j++] !== quote) continue;
      while (j < line.length && /[ \t]/.test(line[j]!)) j++;
    }
    if (line[j] !== ')') continue;
    result.push({ label: unescape(label), target: unescape(target), start: i, end: j + 1 }); i = j;
  }
  return result;
}

export function inspectContextSource(rawLines: string[], profile: Profile): Inspection {
  const lines = [...rawLines]; lines[0] = (lines[0] ?? '').replace(/^\uFEFF/, '');
  const { headings, code } = scan(lines);
  const sections = headings.map(({ heading_end, ...heading }) => heading);
  const diagnostics: Inspection['diagnostics'] = [], references: Inspection['references'] = [];
  const report = (code: string, message: string, line: number, severity: 'error' | 'warning' = 'error') =>
    diagnostics.push({ code, message, severity, start_line: line, end_line: line });
  const titleHeading = headings.find(h => h.level === 1);
  const title = titleHeading?.label ?? null;
  let afterTitle = titleHeading?.heading_end ?? 0;
  while (afterTitle < lines.length && !lines[afterTitle]!.trim()) afterTitle++;
  const summaryLines: string[] = [];
  while (afterTitle < lines.length && /^ {0,3}>/.test(lines[afterTitle]!)) summaryLines.push(lines[afterTitle++]!.replace(/^ {0,3}>[ \t]?/, ''));
  const summary = summaryLines.length ? summaryLines.join('\n') : null;
  for (const [index, line] of lines.entries()) {
    if (code.has(index)) continue;
    for (const link of inlineLinks(line)) references.push({ label: link.label, target: link.target,
      kind: link.target.startsWith('#') ? 'fragment' : /^[a-z][a-z0-9+.-]*:/i.test(link.target) ? 'uri' : link.target.startsWith('/') ? 'absolute' : 'relative',
      start_line: index + 1, end_line: index + 1 });
  }
  for (const heading of headings) {
    const duplicates = headings.filter(h => h.slug === heading.slug);
    if (duplicates.length > 1 && duplicates[0] === heading) report('AMBIGUOUS_HEADING',
      `Heading slug ${JSON.stringify(heading.slug)} repeats; choose ${duplicates.map(h => h.selector).join(', ')}.`, heading.start_line, 'warning');
  }
  if (profile.context_format === 'llms-txt-v2') {
    const first = lines.findIndex(line => line.trim());
    if (!titleHeading?.label || titleHeading.start_line !== first + 1)
      report('INDEX_TITLE_REQUIRED', 'An llms.txt index must start with an H1 title, optionally preceded by a BOM and blank lines.', Math.max(1, first + 1));
    const starts = new Map(headings.map(h => [h.start_line - 1, h]));
    const headingLines = new Set(headings.flatMap(h => Array.from({ length: h.heading_end - h.start_line + 1 }, (_, i) => h.start_line - 1 + i)));
    const labels = new Set<string>(); let inList = false, continuation = false;
    for (const [index, line] of lines.entries()) {
      const heading = starts.get(index);
      if (heading) {
        continuation = false;
        if (heading.level === 2) {
          inList = true;
          if (labels.has(heading.label)) report('DUPLICATE_INDEX_SECTION', `Index section ${JSON.stringify(heading.label)} repeats; keep unique labels.`, index + 1);
          labels.add(heading.label);
        } else if (heading !== titleHeading) report('INVALID_INDEX_HEADING', 'Only the initial H1 and H2 file-list sections are allowed in an llms.txt index.', index + 1);
        continue;
      }
      if (headingLines.has(index) || !line.trim() || !inList) continue;
      // Common Markdown bullets and ordered lists are accepted. Plain indented
      // continuation text belongs to an item's colon-prefixed note.
      if (continuation && /^ {2,}\S/.test(line) && !code.has(index) && !/^\s*(?:[-+*]|\d+[.)])\s/.test(line)) continue;
      continuation = false;
      const item = /^ {0,3}(?:[-+*]|\d+[.)])[ \t]+(.+)$/.exec(line);
      const link = item && inlineLinks(item[1]!)[0];
      const rest = link && item![1]!.slice(link.end).trim();
      if (code.has(index) || !link || link.start !== 0 || !link.label.trim() || (rest && !rest.startsWith(':')))
        report('INVALID_INDEX_ITEM', 'H2 sections require Markdown link list items with optional colon-prefixed notes; put prose, headings and code in a context leaf.', index + 1);
      else continuation = Boolean(rest?.startsWith(':'));
    }
  }
  return { title, summary, sections, references, diagnostics, valid: !diagnostics.some(d => d.severity === 'error') };
}

export function selectContextSection(sections: ContextSection[], selector: string): ContextSection {
  const exact = sections.find(section => section.selector === selector);
  if (exact) return exact;
  const matching = sections.filter(section => section.slug === selector || section.label === selector);
  if (matching.length === 1) return matching[0]!;
  const choices = (matching.length ? matching : sections).map(({ selector, label, start_line, end_line }) => ({ selector, label, start_line, end_line }));
  if (matching.length) throw new AicatlogError('AMBIGUOUS_SECTION', `Heading ${JSON.stringify(selector)} is ambiguous; choose ${matching.map(h => h.selector).join(', ')}.`, { choices });
  throw new AicatlogError('SECTION_NOT_FOUND', `No current heading matches ${JSON.stringify(selector)}; use context inspect to select a heading.`, { choices });
}
