import { randomUUID } from 'node:crypto';

export function newId(prefix = ''): string {
  const id = randomUUID().replace(/-/g, '').slice(0, 24);
  return prefix ? `${prefix}${id}` : id;
}
