/**
 * Generador de PDF mínimo (sin dependencias) con fuentes Helvetica/Courier.
 * Suficiente para construir el RIDE de los comprobantes electrónicos.
 */

type FontName = 'Helvetica' | 'Helvetica-Bold' | 'Courier' | 'Courier-Bold';

interface TextOp {
  x: number;
  y: number;
  text: string;
  size: number;
  font: FontName;
}

interface LineOp {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  width: number;
}

interface RectOp {
  x: number;
  y: number;
  w: number;
  h: number;
  gray: number;
}

const FONT_REFS: Record<FontName, string> = {
  Helvetica: 'F1',
  'Helvetica-Bold': 'F2',
  Courier: 'F3',
  'Courier-Bold': 'F4',
};

/**
 * Caracteres Unicode que WinAnsiEncoding coloca fuera de Latin-1.
 * https://www.adobe.com/content/dam/acom/en/devnet/pdf/PDF32000_2008.pdf (D.2)
 */
const WIN_ANSI_EXTRA: Record<string, number> = {
  '€': 0x80,
  '‚': 0x82,
  'ƒ': 0x83,
  '„': 0x84,
  '…': 0x85,
  '†': 0x86,
  '‡': 0x87,
  'ˆ': 0x88,
  '‰': 0x89,
  'Š': 0x8a,
  '‹': 0x8b,
  'Œ': 0x8c,
  'Ž': 0x8e,
  '‘': 0x91,
  '’': 0x92,
  '“': 0x93,
  '”': 0x94,
  '•': 0x95,
  '–': 0x96,
  '—': 0x97,
  '˜': 0x98,
  '™': 0x99,
  'š': 0x9a,
  '›': 0x9b,
  'œ': 0x9c,
  'ž': 0x9e,
  'Ÿ': 0x9f,
};

/**
 * Convierte texto Unicode a los bytes de WinAnsiEncoding que usa el PDF.
 * No se debe pasar por UTF-8: el PDF escribe los bytes del string tal cual.
 */
export function encodeWinAnsi(text: string): string {
  let out = '';
  for (const char of text.normalize('NFC')) {
    const code = char.codePointAt(0) ?? 0;
    if (code <= 0xff) {
      out += String.fromCharCode(code);
    } else if (WIN_ANSI_EXTRA[char] !== undefined) {
      out += String.fromCharCode(WIN_ANSI_EXTRA[char]!);
    } else {
      out += '?';
    }
  }
  return out;
}

/** Codifica texto a WinAnsi y escapa los caracteres especiales del PDF. */
function pdfText(text: string): string {
  const encoded = encodeWinAnsi(text);
  return encoded.replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)');
}

export class SimplePdf {
  readonly width = 595.28; // A4
  readonly height = 841.89;
  private pages: { texts: TextOp[]; lines: LineOp[]; rects: RectOp[] }[] = [];
  private current: { texts: TextOp[]; lines: LineOp[]; rects: RectOp[] } = { texts: [], lines: [], rects: [] };

  addPage(): void {
    if (this.current.texts.length || this.current.lines.length || this.current.rects.length) {
      this.pages.push(this.current);
    }
    this.current = { texts: [], lines: [], rects: [] };
  }

  text(x: number, y: number, text: string, opts: { size?: number; font?: FontName } = {}): void {
    if (!text) return;
    this.current.texts.push({ x, y, text, size: opts.size ?? 8, font: opts.font ?? 'Helvetica' });
  }

  line(x1: number, y1: number, x2: number, y2: number, width = 0.5): void {
    this.current.lines.push({ x1, y1, x2, y2, width });
  }

  rect(x: number, y: number, w: number, h: number, gray = 0.9): void {
    this.current.rects.push({ x, y, w, h, gray });
  }

  /** Rectángulo usando coordenadas desde arriba (como `text`). */
  box(x: number, top: number, w: number, h: number, gray = 0.9): void {
    this.rect(x, this.height - top - h, w, h, gray);
  }

  /** Línea horizontal usando coordenadas desde arriba. */
  hline(x1: number, x2: number, top: number, width = 0.5): void {
    this.line(x1, this.height - top, x2, this.height - top, width);
  }

  /** Línea vertical usando coordenadas desde arriba. */
  vline(x: number, top1: number, top2: number, width = 0.5): void {
    this.line(x, this.height - top1, x, this.height - top2, width);
  }

  /** Barra negra para códigos de barras. */
  bar(x: number, top: number, w: number, h: number): void {
    this.rect(x, this.height - top - h, w, h, 0);
  }

  /** Texto alineado a la derecha terminando en `right`. */
  textRight(right: number, y: number, text: string, opts: { size?: number; font?: FontName } = {}): void {
    const size = opts.size ?? 8;
    const width = textWidth(text, size, opts.font ?? 'Helvetica');
    this.text(right - width, y, text, opts);
  }

  build(): Buffer {
    if (this.current.texts.length || this.current.lines.length || this.current.rects.length) {
      this.pages.push(this.current);
      this.current = { texts: [], lines: [], rects: [] };
    }
    const objects: string[] = [];
    const pageCount = this.pages.length || 1;

    // 1: Catalog, 2: Pages, 3..: pages, contents, fonts
    const fontObjStart = 3 + pageCount * 2;
    const kids = Array.from({ length: pageCount }, (_, i) => `${3 + i * 2} 0 R`).join(' ');
    objects.push('<< /Type /Catalog /Pages 2 0 R >>');
    objects.push(`<< /Type /Pages /Kids [${kids}] /Count ${pageCount} >>`);

    const pages = this.pages.length ? this.pages : [{ texts: [], lines: [], rects: [] }];
    pages.forEach((page, i) => {
      const contentObj = 4 + i * 2;
      objects.push(
        `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${this.width.toFixed(2)} ${this.height.toFixed(2)}] ` +
          `/Resources << /Font << /F1 ${fontObjStart} 0 R /F2 ${fontObjStart + 1} 0 R /F3 ${fontObjStart + 2} 0 R /F4 ${fontObjStart + 3} 0 R >> >> ` +
          `/Contents ${contentObj} 0 R >>`,
      );
      const content = this.renderPage(page);
      const bytes = Buffer.from(content, 'latin1');
      objects.push(`<< /Length ${bytes.length} >>\nstream\n${content}\nendstream`);
    });

    objects.push('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>');
    objects.push('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>');
    objects.push('<< /Type /Font /Subtype /Type1 /BaseFont /Courier /Encoding /WinAnsiEncoding >>');
    objects.push('<< /Type /Font /Subtype /Type1 /BaseFont /Courier-Bold /Encoding /WinAnsiEncoding >>');

    // Ensamblar PDF
    const chunks: Buffer[] = [];
    chunks.push(Buffer.from('%PDF-1.4\n%\xFF\xFF\xFF\xFF\n', 'latin1'));
    const offsets: number[] = [];
    let position = chunks.reduce((acc, c) => acc + c.length, 0);
    objects.forEach((obj, index) => {
      offsets.push(position);
      const buffer = Buffer.from(`${index + 1} 0 obj\n${obj}\nendobj\n`, 'latin1');
      chunks.push(buffer);
      position += buffer.length;
    });
    const xrefPos = position;
    let xref = `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
    for (const offset of offsets) {
      xref += `${String(offset).padStart(10, '0')} 00000 n \n`;
    }
    xref += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefPos}\n%%EOF\n`;
    chunks.push(Buffer.from(xref, 'latin1'));
    return Buffer.concat(chunks);
  }

  private renderPage(page: { texts: TextOp[]; lines: LineOp[]; rects: RectOp[] }): string {
    const ops: string[] = [];
    for (const r of page.rects) {
      ops.push(`${r.gray} g ${r.x.toFixed(2)} ${r.y.toFixed(2)} ${r.w.toFixed(2)} ${r.h.toFixed(2)} re f 0 g`);
    }
    for (const l of page.lines) {
      ops.push(
        `${l.width} w ${l.x1.toFixed(2)} ${l.y1.toFixed(2)} m ${l.x2.toFixed(2)} ${l.y2.toFixed(2)} l S`,
      );
    }
    for (const t of page.texts) {
      ops.push(
        `BT /${FONT_REFS[t.font]} ${t.size} Tf 1 0 0 1 ${t.x.toFixed(2)} ${(this.height - t.y).toFixed(2)} Tm (${pdfText(t.text)}) Tj ET`,
      );
    }
    return ops.join('\n');
  }
}

/** Ancho aproximado del texto para alinear a la derecha (Helvetica). */
export function textWidth(text: string, size: number, font: FontName = 'Helvetica'): number {
  if (font.startsWith('Courier')) return text.length * size * 0.6;
  const factor = font === 'Helvetica-Bold' ? 0.56 : 0.5;
  return text.length * size * factor;
}
