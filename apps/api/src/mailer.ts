/**
 * Envío de correo por SMTP sin dependencias externas.
 * Compatible con proveedores transaccionales (Brevo, Resend, MailerSend,
 * Amazon SES SMTP, etc.) con STARTTLS o TLS directo y AUTH LOGIN/PLAIN.
 */

import net from 'node:net';
import tls from 'node:tls';
import { config } from './config.ts';

export interface MailAttachment {
  filename: string;
  contentType: string;
  content: Buffer;
}

export interface MailMessage {
  to: string;
  subject: string;
  text: string;
  html?: string;
  attachments?: MailAttachment[];
}

interface SmtpResponse {
  code: number;
  lines: string[];
  text: string;
}

class LineReader {
  private queue: string[] = [];
  private waiters: ((line: string | null) => void)[] = [];
  private closed = false;
  private onClose: (error?: Error) => void;

  private socket: net.Socket | tls.TLSSocket;

  constructor(
    socket: net.Socket | tls.TLSSocket,
    onClose: (error?: Error) => void,
  ) {
    this.socket = socket;
    this.onClose = onClose;
    let buffer = '';
    socket.on('data', (chunk: Buffer) => {
      buffer += chunk.toString('utf8');
      for (;;) {
        const index = buffer.indexOf('\r\n');
        if (index < 0) break;
        const line = buffer.slice(0, index);
        buffer = buffer.slice(index + 2);
        const waiter = this.waiters.shift();
        if (waiter) waiter(line);
        else this.queue.push(line);
      }
    });
    socket.on('error', (error) => this.fail(error));
    socket.on('close', () => this.fail(new Error('La conexión SMTP se cerró inesperadamente')));
  }

  private fail(error: Error): void {
    if (this.closed) return;
    this.closed = true;
    for (const waiter of this.waiters.splice(0)) waiter(null);
    this.onClose(error);
  }

  nextLine(): Promise<string | null> {
    if (this.queue.length > 0) return Promise.resolve(this.queue.shift()!);
    if (this.closed) return Promise.resolve(null);
    return new Promise((resolve) => this.waiters.push(resolve));
  }

  close(): void {
    this.closed = true;
  }
}

class SmtpConnection {
  private reader: LineReader;
  private socket: net.Socket | tls.TLSSocket;
  private lastError: Error | null = null;

  constructor(socket: net.Socket | tls.TLSSocket) {
    this.socket = socket;
    this.reader = new LineReader(socket, (error) => {
      this.lastError = error ?? null;
    });
    socket.setTimeout(30_000, () => {
      this.lastError = new Error('Tiempo de espera agotado en la conexión SMTP');
      socket.destroy();
    });
  }

  async response(): Promise<SmtpResponse> {
    const lines: string[] = [];
    for (;;) {
      const line = await this.reader.nextLine();
      if (line === null) {
        throw this.lastError ?? new Error('Sin respuesta del servidor SMTP');
      }
      lines.push(line);
      if (/^\d{3} /.test(line)) {
        return { code: Number(line.slice(0, 3)), lines, text: lines.join('\n') };
      }
    }
  }

  async command(command: string): Promise<SmtpResponse> {
    this.socket.write(`${command}\r\n`);
    return this.response();
  }

  write(data: string): void {
    this.socket.write(data);
  }

  async expect(command: string, codes: number[]): Promise<SmtpResponse> {
    const response = await this.command(command);
    if (!codes.includes(response.code)) {
      throw new Error(`SMTP: ${command.split(' ')[0]} respondió ${response.text}`);
    }
    return response;
  }

  async startTls(host: string): Promise<void> {
    this.reader.close();
    this.socket.removeAllListeners('data');
    this.socket.removeAllListeners('error');
    this.socket.removeAllListeners('close');
    const secureSocket = await new Promise<tls.TLSSocket>((resolve, reject) => {
      const upgraded = tls.connect({ socket: this.socket, servername: host }, () => resolve(upgraded));
      upgraded.once('error', reject);
    });
    this.socket = secureSocket;
    this.reader = new LineReader(secureSocket, (error) => {
      this.lastError = error ?? null;
    });
  }

  async quit(): Promise<void> {
    try {
      await this.command('QUIT');
    } catch {
      /* el servidor puede cerrar antes de responder */
    }
    this.reader.close();
    this.socket.destroy();
  }

  destroy(): void {
    this.reader.close();
    this.socket.destroy();
  }
}

function connect(host: string, port: number, secure: boolean): Promise<net.Socket | tls.TLSSocket> {
  return new Promise((resolve, reject) => {
    const socket = secure
      ? tls.connect({ host, port, servername: host }, () => resolve(socket))
      : net.connect({ host, port }, () => resolve(socket));
    socket.once('error', reject);
    socket.setTimeout(30_000, () => reject(new Error('Tiempo de espera agotado al conectar al SMTP')));
  });
}

function addressOnly(value: string): string {
  const match = /<([^>]+)>/.exec(value);
  return (match?.[1] ?? value).trim();
}

function encodeHeader(value: string): string {
  // RFC 2047 para asuntos con acentos; el resto viaja como UTF-8.
  if (/^[\x20-\x7e]*$/.test(value)) return value;
  return `=?UTF-8?B?${Buffer.from(value, 'utf8').toString('base64')}?=`;
}

function base64Lines(content: Buffer): string {
  return content.toString('base64').replace(/(.{76})/g, '$1\r\n');
}

function buildMime(message: MailMessage, from: string, boundary: string): string {
  const headers = [
    `From: ${from}`,
    `To: ${message.to}`,
    `Subject: ${encodeHeader(message.subject)}`,
    `Date: ${new Date().toUTCString()}`,
    `Message-ID: <${Date.now()}.${Math.random().toString(36).slice(2)}@${addressOnly(from).split('@')[1] ?? 'localhost'}>`,
    'MIME-Version: 1.0',
  ];
  const attachments = message.attachments ?? [];
  if (attachments.length > 0) {
    headers.push(`Content-Type: multipart/mixed; boundary="${boundary}"`);
    const parts: string[] = [
      `--${boundary}`,
      'Content-Type: text/plain; charset=UTF-8',
      'Content-Transfer-Encoding: 8bit',
      '',
      message.text,
    ];
    if (message.html) {
      parts.push(
        `--${boundary}`,
        'Content-Type: text/html; charset=UTF-8',
        'Content-Transfer-Encoding: 8bit',
        '',
        message.html,
      );
    }
    for (const attachment of attachments) {
      parts.push(
        `--${boundary}`,
        `Content-Type: ${attachment.contentType}; name="${attachment.filename}"`,
        'Content-Transfer-Encoding: base64',
        `Content-Disposition: attachment; filename="${attachment.filename}"`,
        '',
        base64Lines(attachment.content),
      );
    }
    parts.push(`--${boundary}--`);
    return `${headers.join('\r\n')}\r\n\r\n${parts.join('\r\n')}\r\n`;
  }
  return [
    ...headers,
    'Content-Type: text/plain; charset=UTF-8',
    'Content-Transfer-Encoding: 8bit',
    '',
    message.text,
    '',
  ].join('\r\n');
}

function dotStuff(body: string): string {
  return body
    .split('\r\n')
    .map((line) => (line.startsWith('.') ? `.${line}` : line))
    .join('\r\n');
}

export async function sendMail(message: MailMessage): Promise<{ messageId: string }> {
  const smtp = config.smtp;
  if (!smtp.host || !smtp.user || !smtp.pass) {
    throw new Error('SMTP no configurado. Defina SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS y SMTP_FROM.');
  }
  const secure = smtp.secure || smtp.port === 465;
  const socket = await connect(smtp.host, smtp.port, secure);
  const connection = new SmtpConnection(socket);
  try {
    let greeting = await connection.response();
    if (greeting.code !== 220) throw new Error(`SMTP: saludo inesperado ${greeting.text}`);

    let ehlo = await connection.command('EHLO facturacion-ec');
    if (ehlo.code !== 250) throw new Error(`SMTP: EHLO falló ${ehlo.text}`);

    if (!secure && /STARTTLS/i.test(ehlo.text)) {
      await connection.expect('STARTTLS', [220]);
      await connection.startTls(smtp.host);
      ehlo = await connection.command('EHLO facturacion-ec');
      if (ehlo.code !== 250) throw new Error(`SMTP: EHLO tras STARTTLS falló ${ehlo.text}`);
    }

    if (/AUTH[ =]/i.test(ehlo.text)) {
      let auth = await connection.command('AUTH LOGIN');
      if (auth.code === 334) {
        await connection.expect(Buffer.from(smtp.user, 'utf8').toString('base64'), [334]);
        await connection.expect(Buffer.from(smtp.pass, 'utf8').toString('base64'), [235]);
      } else {
        const plain = Buffer.from(`\u0000${smtp.user}\u0000${smtp.pass}`, 'utf8').toString('base64');
        auth = await connection.command(`AUTH PLAIN ${plain}`);
        if (auth.code !== 235) throw new Error(`SMTP: autenticación falló ${auth.text}`);
      }
    } else {
      throw new Error('SMTP: el servidor no ofrece autenticación AUTH');
    }

    const from = addressOnly(smtp.from);
    await connection.expect(`MAIL FROM:<${from}>`, [250]);
    await connection.expect(`RCPT TO:<${addressOnly(message.to)}>`, [250, 251]);
    await connection.expect('DATA', [354]);

    const boundary = `----=_Facturacion_${Date.now()}_${Math.random().toString(36).slice(2)}`;
    const mime = dotStuff(buildMime(message, smtp.from, boundary));
    connection.write(mime.endsWith('\r\n') ? mime : `${mime}\r\n`);
    connection.write('.\r\n');
    const accepted = await connection.response();
    if (accepted.code !== 250) throw new Error(`SMTP: el mensaje fue rechazado ${accepted.text}`);
    await connection.quit();
    return { messageId: accepted.text };
  } catch (error) {
    connection.destroy();
    throw error;
  }
}
