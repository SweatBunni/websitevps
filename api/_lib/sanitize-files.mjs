import path from 'node:path';

export function sanitizeFiles(files) {
  if (!files || typeof files !== 'object' || Array.isArray(files)) {
    throw new Error('files must be an object keyed by relative file path.');
  }

  const sanitized = {};
  for (const [relativePath, file] of Object.entries(files)) {
    const safePath = sanitizeRelativePath(relativePath);
    sanitized[safePath] = normalizeFileData(file);
  }
  return sanitized;
}

function normalizeFileData(file) {
  if (typeof file === 'string') {
    return { encoding: 'utf8', content: file };
  }

  return {
    encoding: file && file.encoding === 'base64' ? 'base64' : 'utf8',
    content: file && typeof file.content === 'string' ? file.content : '',
  };
}

function sanitizeRelativePath(relativePath) {
  if (typeof relativePath !== 'string' || !relativePath.trim()) {
    throw new Error('Each file must have a non-empty relative path.');
  }

  const normalized = relativePath.replace(/\\/g, '/').replace(/^\/+/, '');
  if (!normalized || normalized.includes('..') || path.isAbsolute(normalized)) {
    throw new Error(`Unsafe file path: ${relativePath}`);
  }

  return normalized;
}
