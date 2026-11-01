import { createHash } from 'node:crypto';

export type CanonicalValue =
  | string
  | boolean
  | null
  | readonly CanonicalValue[]
  | { readonly [key: string]: CanonicalValue | undefined };

export function canonicalJson(value: CanonicalValue): string {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value);
  }
  if (isList(value)) {
    return `[${value.map(canonicalJson).join(',')}]`;
  }
  const members: string[] = [];
  for (const key of Object.keys(value).sort(compareCodePoints)) {
    const member = value[key];
    if (member !== undefined) {
      members.push(`${JSON.stringify(key)}:${canonicalJson(member)}`);
    }
  }
  return `{${members.join(',')}}`;
}

export function sha256Hex(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

function isList(
  value: readonly CanonicalValue[] | { readonly [key: string]: unknown },
): value is readonly CanonicalValue[] {
  return Array.isArray(value);
}

function compareCodePoints(left: string, right: string): number {
  if (left === right) {
    return 0;
  }
  return left < right ? -1 : 1;
}
