import { AppError } from '../core/errors.js';

const prohibitedPatterns = [
  /\bcounterfeit\b/i,
  /\bstolen\b/i,
  /\bweapon(?:s)?\b/i,
  /\bcontrolled substance(?:s)?\b/i,
  /\bmiracle cure\b/i,
];

export function inspectProductContent({ title, description, tags = [] }) {
  const combined = `${title}\n${description}\n${tags.join(' ')}`;
  const matched = prohibitedPatterns.find((pattern) => pattern.test(combined));
  if (matched) {
    throw new AppError(
      'This content contains a restricted marketplace term.',
      422,
      'RESTRICTED_CONTENT',
    );
  }
  if (/<[^>]+>|javascript:|data:text\/html/i.test(combined)) {
    throw new AppError(
      'HTML and executable content are not allowed in catalogue fields.',
      422,
      'UNSAFE_CONTENT',
    );
  }
}

export function calculateQualityScore({
  title,
  description,
  tags = [],
  variantCount = 0,
  mediaCount = 0,
  hasBrand = false,
}) {
  let score = 0;
  if (title?.length >= 12) score += 15;
  else if (title?.length >= 3) score += 8;
  if (description?.length >= 150) score += 30;
  else if (description?.length >= 60) score += 20;
  else if (description?.length >= 20) score += 10;
  score += Math.min(tags.length * 3, 15);
  if (hasBrand) score += 10;
  if (variantCount > 0) score += 15;
  if (mediaCount >= 3) score += 15;
  else if (mediaCount > 0) score += 8;
  return Math.min(score, 100);
}

export function toMinorUnits(amount, currency) {
  const zeroDecimal = new Set(['UGX', 'RWF']);
  const factor = zeroDecimal.has(currency) ? 1 : 100;
  const numeric = Number(amount);
  if (!Number.isFinite(numeric) || numeric < 0) {
    throw new AppError('Enter a valid non-negative price.', 422, 'PRICE_INVALID');
  }
  return Math.round((numeric + Number.EPSILON) * factor);
}

export function formatMinorUnits(amount, currency, locale = 'en-UG') {
  const zeroDecimal = new Set(['UGX', 'RWF']);
  const factor = zeroDecimal.has(currency) ? 1 : 100;
  return new Intl.NumberFormat(locale, {
    style: 'currency',
    currency,
    maximumFractionDigits: zeroDecimal.has(currency) ? 0 : 2,
  }).format(amount / factor);
}

export function parseCatalogueCsv(source) {
  const lines = String(source)
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  if (lines.length < 2) {
    throw new AppError(
      'CSV needs a header and at least one product row.',
      422,
      'CSV_EMPTY',
    );
  }
  if (lines.length > 501) {
    throw new AppError(
      'Import at most 500 rows at a time.',
      422,
      'CSV_TOO_LARGE',
    );
  }

  const parseLine = (line) => {
    const cells = [];
    let current = '';
    let quoted = false;
    for (let index = 0; index < line.length; index += 1) {
      const character = line[index];
      if (character === '"' && line[index + 1] === '"' && quoted) {
        current += '"';
        index += 1;
      } else if (character === '"') {
        quoted = !quoted;
      } else if (character === ',' && !quoted) {
        cells.push(current.trim());
        current = '';
      } else {
        current += character;
      }
    }
    if (quoted) {
      throw new AppError('CSV contains an unclosed quote.', 422, 'CSV_INVALID');
    }
    cells.push(current.trim());
    return cells;
  };

  const expected = ['title', 'description', 'category', 'sku', 'price'];
  const header = parseLine(lines[0]).map((item) => item.toLowerCase());
  if (expected.some((field, index) => header[index] !== field)) {
    throw new AppError(
      `CSV header must be: ${expected.join(',')}`,
      422,
      'CSV_HEADER_INVALID',
    );
  }

  return lines.slice(1).map((line, index) => {
    const [title, description, category, sku, price] = parseLine(line);
    const errors = [];
    if (!title || title.length > 180) errors.push('invalid title');
    if (!description || description.length < 20 || description.length > 5_000) {
      errors.push('description must be 20–5000 characters');
    }
    if (!category) errors.push('category is required');
    if (!/^[A-Z0-9][A-Z0-9._-]{1,63}$/i.test(sku || '')) {
      errors.push('invalid SKU');
    }
    if (!/^\d{1,10}(?:\.\d{1,2})?$/.test(price || '')) {
      errors.push('invalid price');
    }
    return {
      row: index + 2,
      title,
      description,
      category,
      sku: sku?.toUpperCase(),
      price,
      errors,
    };
  });
}

export function parseCategoryAttributes(source) {
  if (!String(source || '').trim()) return [];
  const lines = String(source)
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  if (lines.length > 30) {
    throw new AppError(
      'A category can define at most 30 attributes.',
      422,
      'ATTRIBUTE_LIMIT',
    );
  }
  const seen = new Set();
  return lines.map((line, index) => {
    const [rawKey, rawLabel, rawType = 'text', rawRequired = 'no'] = line
      .split('|')
      .map((item) => item.trim());
    const key = rawKey?.toLowerCase().replace(/[^a-z0-9_]+/g, '_');
    if (!key || key.length > 60 || seen.has(key)) {
      throw new AppError(
        `Attribute line ${index + 1} has an invalid or duplicate key.`,
        422,
        'ATTRIBUTE_INVALID',
      );
    }
    if (!rawLabel || rawLabel.length > 80) {
      throw new AppError(
        `Attribute line ${index + 1} needs a label.`,
        422,
        'ATTRIBUTE_INVALID',
      );
    }
    if (!['text', 'number', 'boolean', 'select'].includes(rawType)) {
      throw new AppError(
        `Attribute line ${index + 1} has an invalid type.`,
        422,
        'ATTRIBUTE_INVALID',
      );
    }
    seen.add(key);
    return {
      key,
      label: rawLabel,
      type: rawType,
      required: rawRequired.toLowerCase() === 'yes',
      options: [],
    };
  });
}
