import path from 'node:path';

export function sanitizeFiles(files) {
  if (!files || typeof files !== 'object' || Array.isArray(files)) {
    throw new Error('files must be an object keyed by relative file path.');
  }

  const sanitized = {};
  for (const [filePath, fileValue] of Object.entries(files)) {
    sanitized[normalizeRelativePath(filePath)] = normalizeFileValue(fileValue);
  }
  return sanitized;
}

export function normalizeFileValue(fileValue) {
  if (typeof fileValue === 'string') {
    return { encoding: 'utf8', content: fileValue };
  }

  return {
    encoding: fileValue?.encoding === 'base64' ? 'base64' : 'utf8',
    content: typeof fileValue?.content === 'string' ? fileValue.content : '',
  };
}

function normalizeRelativePath(filePath) {
  const normalized = String(filePath || '').trim().replace(/\\/g, '/').replace(/^\/+/, '');
  if (!normalized || normalized.includes('..') || path.isAbsolute(normalized)) {
    throw new Error(`Unsafe file path: ${filePath}`);
  }
  return normalized;
}
