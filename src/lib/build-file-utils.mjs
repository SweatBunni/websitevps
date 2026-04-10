import path from 'node:path';

export function sanitizeFiles(files) {
  const sanitized = {};
  for (const [relativePath, file] of Object.entries(files || {})) {
    sanitized[sanitizeRelativePath(relativePath)] = normalizeFileData(file);
  }
  return sanitized;
}

export function normalizeFileData(file) {
  if (typeof file === 'string') {
    return { encoding: 'utf8', content: file };
  }

  return {
    encoding: file && file.encoding === 'base64' ? 'base64' : 'utf8',
    content: file && typeof file.content === 'string' ? file.content : '',
  };
}

export function tail(value, maxChars) {
  const text = String(value || '');
  return text.length <= maxChars ? text : text.slice(text.length - maxChars);
}

export function extractBuildFailureSignature(log) {
  const picked = String(log || '')
    .split(/\r?\n/)
    .map(line => line.trim())
    .filter(Boolean)
    .filter(line => (
      /^\*\s+What went wrong:/i.test(line)
      || /^\>\s/.test(line)
      || /error:/i.test(line)
      || /cannot find symbol/i.test(line)
      || /package .* does not exist/i.test(line)
    ))
    .slice(0, 8)
    .map(line => line.replace(/\s+/g, ' '));

  return picked.join(' | ').slice(0, 1200);
}

export function buildRepairFingerprint(files, summary, changedFiles) {
  const selectedFiles = (Array.isArray(changedFiles) ? changedFiles : [])
    .slice()
    .sort()
    .map(filePath => `${filePath}:${tail(normalizeFileData(files[filePath]).content, 240)}`);

  return `${summary || ''}\n${selectedFiles.join('\n')}`;
}

export function extractLatestPrompt(conversation) {
  for (const entry of [...(Array.isArray(conversation) ? conversation : [])].reverse()) {
    if (entry?.role !== 'user') {
      continue;
    }

    const content = String(entry.content || '').trim();
    if (!content) {
      continue;
    }

    const marker = '[User request]';
    return content.includes(marker) ? content.split(marker).pop().trim() : content;
  }

  return '';
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
