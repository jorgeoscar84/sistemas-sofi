/**
 * Parser XML mínimo (sin dependencias) para leer las respuestas SOAP del SRI.
 * Ignora prefijos de namespace al comparar nombres (local-name).
 */

export interface XmlNode {
  name: string;
  attrs: Record<string, string>;
  children: XmlNode[];
  text: string;
}

function localName(name: string): string {
  const index = name.indexOf(':');
  return index >= 0 ? name.slice(index + 1) : name;
}

function decodeEntities(value: string): string {
  return value
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, code: string) => String.fromCodePoint(Number(code)))
    .replace(/&amp;/g, '&');
}

export function parseXml(text: string): XmlNode {
  let index = 0;
  const source = text.replace(/^\uFEFF/, '');
  const root: XmlNode = { name: '#document', attrs: {}, children: [], text: '' };
  const stack: XmlNode[] = [root];

  const readUntil = (terminator: string): string => {
    const end = source.indexOf(terminator, index);
    const value = end < 0 ? source.slice(index) : source.slice(index, end);
    index = end < 0 ? source.length : end + terminator.length;
    return value;
  };

  while (index < source.length) {
    const open = source.indexOf('<', index);
    if (open < 0) {
      stack[stack.length - 1]!.text += decodeEntities(source.slice(index));
      break;
    }
    if (open > index) {
      stack[stack.length - 1]!.text += decodeEntities(source.slice(index, open));
    }
    index = open;

    if (source.startsWith('<?', index)) {
      readUntil('?>');
      continue;
    }
    if (source.startsWith('<!--', index)) {
      readUntil('-->');
      continue;
    }
    if (source.startsWith('<![CDATA[', index)) {
      index += '<![CDATA['.length;
      const end = source.indexOf(']]>', index);
      const value = end < 0 ? source.slice(index) : source.slice(index, end);
      index = end < 0 ? source.length : end + 3;
      stack[stack.length - 1]!.text += value;
      continue;
    }
    if (source.startsWith('<!', index)) {
      readUntil('>');
      continue;
    }
    if (source.startsWith('</', index)) {
      const end = source.indexOf('>', index);
      index = end < 0 ? source.length : end + 1;
      if (stack.length > 1) stack.pop();
      continue;
    }

    // Etiqueta de apertura
    const end = source.indexOf('>', index);
    if (end < 0) break;
    const raw = source.slice(index + 1, end);
    index = end + 1;
    const selfClosing = raw.endsWith('/');
    const content = selfClosing ? raw.slice(0, -1) : raw;
    const space = content.search(/\s/);
    const name = localName(space < 0 ? content : content.slice(0, space));
    const attrs: Record<string, string> = {};
    if (space >= 0) {
      const attrText = content.slice(space);
      const re = /([A-Za-z0-9_:.-]+)\s*=\s*("([^"]*)"|'([^']*)')/g;
      let match: RegExpExecArray | null;
      while ((match = re.exec(attrText)) !== null) {
        attrs[localName(match[1]!)] = decodeEntities(match[3] ?? match[4] ?? '');
      }
    }
    const node: XmlNode = { name, attrs, children: [], text: '' };
    stack[stack.length - 1]!.children.push(node);
    if (!selfClosing) stack.push(node);
  }
  return root;
}

/** Primer descendiente con el nombre indicado. */
export function find(node: XmlNode, name: string): XmlNode | undefined {
  for (const child of node.children) {
    if (child.name === name) return child;
    const found = find(child, name);
    if (found) return found;
  }
  return undefined;
}

/** Todos los descendientes con el nombre indicado. */
export function findAll(node: XmlNode, name: string): XmlNode[] {
  const out: XmlNode[] = [];
  for (const child of node.children) {
    if (child.name === name) out.push(child);
    out.push(...findAll(child, name));
  }
  return out;
}

/** Hijo directo con el nombre indicado. */
export function child(node: XmlNode | undefined, name: string): XmlNode | undefined {
  return node ? node.children.find((candidate) => candidate.name === name) : undefined;
}

export function childText(node: XmlNode | undefined, name: string): string | undefined {
  const found = child(node, name);
  return found ? found.text.trim() || undefined : undefined;
}

export function text(node: XmlNode | undefined): string | undefined {
  if (!node) return undefined;
  const value = node.text.trim();
  return value || undefined;
}

/** Texto completo de un subárbol (incluye CDATA concatenada). */
export function innerText(node: XmlNode): string {
  return (node.text + node.children.map(innerText).join('')).trim();
}
