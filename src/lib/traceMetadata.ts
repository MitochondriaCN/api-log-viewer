import { classifyClient } from './client';

export function requestHeader(headers: Record<string, unknown> | undefined, name: string): string {
  for (const [key, value] of Object.entries(headers ?? {})) {
    if (key.toLowerCase() === name.toLowerCase() && typeof value === 'string') return value;
  }
  return '';
}

function requestKey(headers: Record<string, unknown> | undefined): string {
  const authorization = requestHeader(headers, 'authorization').trim();
  const bearer = authorization.match(/^Bearer\s+(.+)$/i)?.[1]?.trim();
  const key = bearer || requestHeader(headers, 'x-api-key').trim();
  // Masked values are not evidence of the original key's suffix.
  if (!key || /[…*]|\.{3}/.test(key)) return '';
  return key;
}

export function extractApiKeySuffix(headers: Record<string, unknown> | undefined): string {
  const key = requestKey(headers);
  return key.length > 4 ? key.slice(-4) : '';
}

export function maskedRequestKey(headers: Record<string, unknown> | undefined): string {
  const key = requestKey(headers);
  if (!key) return '';
  if (key.length <= 12) return '…' + key.slice(-4);
  return key.slice(0, 6) + '…' + key.slice(-4);
}

export function requestClient(headers: Record<string, unknown> | undefined) {
  return classifyClient(requestHeader(headers, 'user-agent'));
}

export interface TraceMetadata {
  keySuffix: string;
  clientKind: string;
  clientVersion?: string;
}

export function extractTraceMetadata(headers: Record<string, unknown> | undefined): TraceMetadata {
  const client = requestClient(headers);
  return {
    keySuffix: extractApiKeySuffix(headers),
    clientKind: client.family === 'unknown' ? '' : client.family,
    clientVersion: client.version,
  };
}
