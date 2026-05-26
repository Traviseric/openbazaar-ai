'use strict';

const fs = require('fs').promises;
const path = require('path');
const { getTemplate, buildThemeCss } = require('./archetypeTemplates');
const brandStore = require('./brandStore');

const MAX_ASSET_BYTES = Number(process.env.MARKETPLACE_ASSET_MAX_BYTES || 75 * 1024 * 1024);

function brandsDir() {
  return path.resolve(
    process.env.MARKETPLACE_BRANDS_DIR ||
    path.join(__dirname, '..', '..', 'frontend', 'brands')
  );
}

function slugify(value, fallback = 'territory-storefront') {
  const slug = String(value || fallback)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 72);
  return slug || fallback;
}

function assertSafeBrandSlug(slug) {
  if (!/^[a-z0-9][a-z0-9-]{1,79}$/.test(slug)) {
    const err = new Error('Invalid storefront slug');
    err.statusCode = 400;
    throw err;
  }
  const base = brandsDir();
  const resolved = path.resolve(base, slug);
  if (!resolved.startsWith(base + path.sep) && resolved !== base) {
    const err = new Error('Invalid storefront slug');
    err.statusCode = 400;
    throw err;
  }
  return resolved;
}

async function readJson(filePath, fallback) {
  try {
    return JSON.parse(await fs.readFile(filePath, 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') return fallback;
    throw error;
  }
}

async function writeJson(filePath, value) {
  await fs.writeFile(filePath, JSON.stringify(value, null, 2) + '\n');
}

function safeAssetId(value, fallback = 'book') {
  return slugify(value, fallback).slice(0, 96);
}

function isHttpUrl(value) {
  try {
    const parsed = new URL(value);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:';
  } catch {
    return false;
  }
}

function extensionFromContentType(contentType) {
  const normalized = String(contentType || '').toLowerCase().split(';')[0].trim();
  if (normalized === 'application/epub+zip') return 'epub';
  if (normalized === 'application/pdf') return 'pdf';
  if (normalized === 'image/jpeg') return 'jpg';
  if (normalized === 'image/png') return 'png';
  if (normalized === 'image/webp') return 'webp';
  return null;
}

function extensionFromUrl(url) {
  try {
    const ext = path.extname(new URL(url).pathname).replace(/^\./, '').toLowerCase();
    return /^[a-z0-9]{1,8}$/.test(ext) ? ext : null;
  } catch {
    return null;
  }
}

function formatExtension(format, sourceUrl, contentType) {
  return extensionFromContentType(contentType) || extensionFromUrl(sourceUrl) || {
    epub: 'epub',
    pdf: 'pdf',
  }[format] || 'bin';
}

async function downloadRemoteAsset(sourceUrl, destinationPath) {
  if (!isHttpUrl(sourceUrl) || typeof fetch !== 'function') {
    return { stored: false, reason: 'unsupported-source' };
  }

  const response = await fetch(sourceUrl);
  if (!response.ok) {
    return { stored: false, reason: `download-${response.status}` };
  }

  const contentLength = Number(response.headers?.get?.('content-length') || 0);
  if (contentLength > MAX_ASSET_BYTES) {
    return { stored: false, reason: 'asset-too-large' };
  }

  const buffer = Buffer.from(await response.arrayBuffer());
  if (buffer.length > MAX_ASSET_BYTES) {
    return { stored: false, reason: 'asset-too-large' };
  }

  await fs.mkdir(path.dirname(destinationPath), { recursive: true });
  await fs.writeFile(destinationPath, buffer);
  return {
    stored: true,
    bytes: buffer.length,
    contentType: response.headers?.get?.('content-type') || null,
  };
}

async function custodyFormatFile(formatFile, slug, bookAssetId, brandDir) {
  const sourceUrl = formatFile.url || formatFile.downloadUrl;
  if (!sourceUrl) return formatFile;

  const next = { ...formatFile, sourceUrl };
  if (!isHttpUrl(sourceUrl)) {
    return next;
  }

  const provisionalExt = formatExtension(formatFile.type, sourceUrl);
  const provisionalPath = path.join(brandDir, 'books', bookAssetId, `${safeAssetId(formatFile.type, 'file')}.${provisionalExt}`);
  try {
    const result = await downloadRemoteAsset(sourceUrl, provisionalPath);
    if (!result.stored) {
      return { ...next, custody: { status: 'external', reason: result.reason } };
    }

    const finalExt = formatExtension(formatFile.type, sourceUrl, result.contentType);
    const finalName = `${safeAssetId(formatFile.type, 'file')}.${finalExt}`;
    const finalPath = path.join(brandDir, 'books', bookAssetId, finalName);
    if (finalPath !== provisionalPath) {
      await fs.rename(provisionalPath, finalPath);
    }
    const localUrl = `/brands/${slug}/books/${bookAssetId}/${finalName}`;
    return {
      ...next,
      url: localUrl,
      storedPath: localUrl,
      custody: {
        status: 'stored',
        bytes: result.bytes,
        sourceUrl,
        storedAt: new Date().toISOString(),
      },
    };
  } catch (error) {
    return { ...next, custody: { status: 'failed', error: error.message } };
  }
}

async function custodyCover(book, slug, bookAssetId, brandDir) {
  const sourceUrl = book.coverUrl || book.coverImage;
  if (!isHttpUrl(sourceUrl)) {
    return sourceUrl || `/brands/${slug}/assets/covers/${bookAssetId}.jpg`;
  }

  const provisionalExt = extensionFromUrl(sourceUrl) || 'jpg';
  const provisionalPath = path.join(brandDir, 'assets', 'covers', `${bookAssetId}.${provisionalExt}`);
  try {
    const result = await downloadRemoteAsset(sourceUrl, provisionalPath);
    if (!result.stored) return sourceUrl;

    const finalExt = extensionFromContentType(result.contentType) || provisionalExt;
    const finalPath = path.join(brandDir, 'assets', 'covers', `${bookAssetId}.${finalExt}`);
    if (finalPath !== provisionalPath) {
      await fs.rename(provisionalPath, finalPath);
    }
    return `/brands/${slug}/assets/covers/${bookAssetId}.${finalExt}`;
  } catch {
    return sourceUrl;
  }
}

function normalizeTerritory(payload) {
  const territory = payload.territory || payload.territorySnapshot || {};
  const territoryId = territory.territoryId || territory.id || payload.territoryId;
  if (!territoryId) {
    const err = new Error('territory.territoryId is required');
    err.statusCode = 400;
    throw err;
  }
  return {
    ...territory,
    territoryId,
    name: territory.name || territory.territoryName || territoryId,
    businessArchetypes: territory.businessArchetypes || ['AUTHORITY_BRAND'],
    publishingCodeFlags: territory.publishingCodeFlags || [],
    mission: typeof territory.mission === 'object' && territory.mission
      ? territory.mission
      : { problem: territory.mission || '', solution: '', impact: '' },
  };
}

function primaryArchetype(territory) {
  const archetypes = Array.isArray(territory.businessArchetypes) ? territory.businessArchetypes : [];
  return archetypes.find((item) => item && item !== 'KDP_CATALOG') || archetypes[0] || 'AUTHORITY_BRAND';
}

function buildDisclaimer(territory) {
  const flags = Array.isArray(territory.publishingCodeFlags) ? territory.publishingCodeFlags : [];
  const parts = ['This material is for educational and research purposes only.'];
  if (flags.includes('legal-uncertainty')) {
    parts.push('Nothing here is legal advice. Consult a licensed attorney for jurisdiction-specific guidance.');
  }
  if (flags.includes('health-uncertainty') || flags.includes('medical-uncertainty')) {
    parts.push('Nothing here is medical advice. Consult a licensed clinician before acting on anything you read.');
  }
  if (flags.includes('financial-uncertainty')) {
    parts.push('Nothing here is financial advice. Consult a licensed advisor before making financial decisions.');
  }
  if (flags.includes('political-content')) {
    parts.push('Strategic and analytical content only. Encourages peaceful, lawful, ethical action.');
  }
  return parts.join(' ');
}

function normalizeLeadCapture(payload) {
  const source = payload.leadCapture || payload.landingPage?.leadCapture;
  if (!source || typeof source !== 'object') return null;

  const endpointUrl = source.endpointUrl || source.url || source.action;
  if (!isHttpUrl(endpointUrl)) return null;
  const method = String(source.method || 'POST').toUpperCase();

  return {
    enabled: source.enabled !== false,
    endpointUrl,
    endpointPath: source.endpointPath || source.path || '/brand-leads',
    method: ['POST', 'PUT', 'PATCH'].includes(method) ? method : 'POST',
    payloadDefaults: source.payloadDefaults && typeof source.payloadDefaults === 'object'
      ? { ...source.payloadDefaults }
      : {},
    fields: Array.isArray(source.fields) ? source.fields : ['email', 'name'],
    honeypot: source.honeypot || 'company',
    privacy: source.privacy && typeof source.privacy === 'object'
      ? { ...source.privacy }
      : {},
    source: source.source || 'teneo-production',
  };
}

function buildConfig(slug, territory, payload, existing = {}) {
  const archetype = primaryArchetype(territory);
  const template = getTemplate(archetype);
  const positioning = payload.positioning || {};

  return {
    ...existing,
    brand: slug,
    id: slug,
    name: existing.name || territory.name,
    tagline: territory.tagline || positioning.promise || territory.capabilityRestored || '',
    description: positioning.impact || territory.mission.impact || territory.mission.solution || '',
    theme: {
      backgroundColor: '#FFFFFF',
      textColor: '#111827',
      font: 'system-ui, -apple-system, sans-serif',
      ...template.theme,
      ...(existing.theme || {}),
    },
    features: {
      enableStripe: true,
      enableCrypto: true,
      showReviews: false,
      enableSharing: true,
      ...template.features,
      ...(existing.features || {}),
    },
    copy: {
      ...template.copy,
      heroTitle: territory.tagline || `Restoring ${territory.capabilityRestored || 'human capability'}`,
      heroSubtitle: territory.readerTransformation || territory.mission?.solution || '',
      ...(existing.copy || {}),
    },
    payments: existing.payments || {
      stripe: { enabled: true },
      lightning: { enabled: true },
    },
    territory: {
      territoryId: territory.territoryId,
      domain: territory.domain || null,
      capabilityRestored: territory.capabilityRestored || null,
      readerTransformation: territory.readerTransformation || null,
      businessArchetypes: territory.businessArchetypes,
      primaryArchetype: archetype,
      publishingCodeFlags: territory.publishingCodeFlags,
      mission: territory.mission,
      audience: payload.audience || {},
      positioning,
    },
    legal: {
      ...(existing.legal || {}),
      disclaimer: existing.legal?.disclaimer || buildDisclaimer(territory),
      publishingCodeFlags: territory.publishingCodeFlags,
    },
    branding: {
      ...(existing.branding || {}),
      aboutText: existing.branding?.aboutText || positioning.promise || territory.mission.solution || '',
    },
    leadCapture: normalizeLeadCapture(payload) || existing.leadCapture || null,
    source: {
      system: 'teneo-production',
      claim: payload.claim || {},
      createdAt: existing.source?.createdAt || new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    },
  };
}

function roadmapCollections(territory) {
  const books = Array.isArray(territory.roadmapBooks) ? territory.roadmapBooks : [];
  return [{
    id: 'roadmap',
    name: `${territory.name} Roadmap`,
    description: territory.mission.solution || territory.tagline || '',
    books: books.map((book) => book.id || slugify(book.title)),
  }];
}

async function normalizeBook(book, territory, slug, brandDir) {
  if (!book || !book.title) return null;
  const id = book.plannedBookId || book.id || book.bookId || book.teneoBookId || slugify(book.title);
  const bookAssetId = safeAssetId(id);
  const teneoBookId = book.teneoBookId || book.bookId || null;
  const rawFormats = book.formatFiles || book.formats || [];
  const externalFormatFiles = Array.isArray(rawFormats)
    ? rawFormats.filter((item) => item && typeof item === 'object')
    : [];
  const formatFiles = [];
  for (const formatFile of externalFormatFiles) {
    formatFiles.push(await custodyFormatFile(formatFile, slug, bookAssetId, brandDir));
  }
  const formatNames = Array.isArray(rawFormats)
    ? rawFormats.map((item) => (typeof item === 'string' ? item : item.type)).filter(Boolean)
    : ['digital'];
  const digitalFile = formatFiles.find((item) => item.type === 'epub') || formatFiles[0] || book.digitalFile || null;
  const coverImage = await custodyCover(book, slug, bookAssetId, brandDir);
  return {
    id,
    plannedBookId: book.plannedBookId || null,
    teneoBookId,
    title: book.title,
    subtitle: book.subtitle || '',
    author: book.author || territory.name,
    description: book.descriptionMd || book.description || book.impact || territory.mission.solution || '',
    longDescription: book.longDescription || book.descriptionMd || book.description || '',
    price: Number(book.priceUSD || book.price || 9.99),
    currency: 'USD',
    status: book.status || (teneoBookId ? 'live' : 'planned'),
    format: formatNames.length ? formatNames : ['digital'],
    formats: formatFiles,
    coverImage,
    digitalFile,
    listingId: book.listingId || null,
    tags: [
      territory.territoryId,
      primaryArchetype(territory).toLowerCase().replace(/_/g, '-'),
    ],
    metadata: {
      source: 'teneo-production',
      territoryId: territory.territoryId,
      publishingCodeFlags: territory.publishingCodeFlags,
      roadmapPriority: book.priority || null,
      plannedBookId: book.plannedBookId || null,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    },
  };
}

function upsertBook(books, book) {
  if (!book) return books;
  const index = books.findIndex((existing) => (
    existing.id === book.id ||
    (book.plannedBookId && (existing.plannedBookId === book.plannedBookId || existing.id === book.plannedBookId)) ||
    (book.teneoBookId && existing.teneoBookId === book.teneoBookId)
  ));
  if (index >= 0) {
    const next = [...books];
    next[index] = { ...next[index], ...book, metadata: { ...(next[index].metadata || {}), ...(book.metadata || {}) } };
    return next;
  }
  return [book, ...books];
}

async function tryFsWrite(fn, label) {
  try {
    await fn();
    return true;
  } catch (err) {
    // @vercel/node serverless: marketplace/frontend/brands/ is read-only at
    // runtime. DB write is authoritative; FS writes are best-effort for
    // local dev where the brand folder is browsable directly.
    if (err && (err.code === 'EROFS' || err.code === 'EACCES' || err.code === 'EPERM')) {
      // Expected in production. Silent skip.
      return false;
    }
    console.warn(`[scaffoldStorefront] FS write skipped (${label}): ${err.message}`);
    return false;
  }
}

async function scaffoldStorefront(payload) {
  const territory = normalizeTerritory(payload);
  const slug = slugify(payload.slug || territory.slug || territory.territoryId || territory.name);
  const brandDir = assertSafeBrandSlug(slug);

  // Load any existing brand row from DB (authoritative source) and merge.
  // Falls back to FS for built-in brands that pre-date this table.
  const existingBrand = await brandStore.getBySlug(slug);
  const existingConfig = existingBrand?.config
    || await readJson(path.join(brandDir, 'config.json'), {}).catch(() => ({}));
  const existingCatalog = existingBrand?.catalog
    || await readJson(path.join(brandDir, 'catalog.json'), {}).catch(() => ({}));

  const firstBook = await normalizeBook(payload.firstBook, territory, slug, brandDir);
  const catalog = {
    ...existingCatalog,
    brand: slug,
    name: existingCatalog.name || `${territory.name} Catalog`,
    description: existingCatalog.description || territory.mission.solution || territory.tagline || '',
    territoryId: territory.territoryId,
    collections: existingCatalog.collections || roadmapCollections(territory),
    books: upsertBook(existingCatalog.books || [], firstBook),
    lastUpdated: new Date().toISOString(),
  };

  const config = buildConfig(slug, territory, payload, existingConfig);
  const variables = {
    HERO_HEADLINE: territory.name,
    HERO_SUBHEADLINE: config.tagline,
    BUTTON_TEXT: 'Browse Books',
    TERRITORY_ID: territory.territoryId,
    PRIMARY_ARCHETYPE: config.territory.primaryArchetype,
    FIRST_BOOK_TITLE: firstBook?.title || '',
  };
  const themeCss = buildThemeCss(slug, config);

  const publicBase = (process.env.PUBLIC_URL || process.env.FRONTEND_URL || 'https://openbazaar.ai')
    .trim()
    .replace(/\/$/, '');
  const publicUrl = `${publicBase}/store/store.html?brand=${encodeURIComponent(slug)}`;
  const catalogUrl = `${publicBase}/api/storefront/brands/${encodeURIComponent(slug)}/catalog.json`;

  // 1) Authoritative DB write — must succeed in any environment.
  await brandStore.upsert({
    slug,
    territoryId: territory.territoryId,
    archetype: config.territory.primaryArchetype,
    config,
    catalog,
    variables,
    themeCss,
    publishingCodeFlags: territory.publishingCodeFlags || [],
    publicUrl,
    catalogUrl,
    status: 'live',
    bookCount: (catalog.books || []).length,
  });

  // 2) Best-effort FS writes — only succeed where the filesystem is writable
  // (local dev, persistent-disk hosts). In production serverless (Vercel,
  // @vercel/node) these silently no-op and the DB row is the only artifact.
  await tryFsWrite(async () => {
    await fs.mkdir(path.join(brandDir, 'assets', 'covers'), { recursive: true });
    await fs.mkdir(path.join(brandDir, 'books'), { recursive: true });
    await fs.mkdir(path.join(brandDir, 'blog'), { recursive: true });
    await fs.mkdir(path.join(brandDir, 'css'), { recursive: true });
    await writeJson(path.join(brandDir, 'config.json'), config);
    await writeJson(path.join(brandDir, 'catalog.json'), catalog);
    await writeJson(path.join(brandDir, 'variables.json'), variables);
    await fs.writeFile(path.join(brandDir, 'css', 'theme.css'), themeCss);
  }, 'brand folder');

  return {
    storefrontId: slug,
    slug,
    brandId: slug,
    publicUrl,
    catalogUrl,
    status: 'live',
    bookCount: catalog.books.length,
    primaryArchetype: config.territory.primaryArchetype,
  };
}

module.exports = {
  scaffoldStorefront,
  slugify,
};
