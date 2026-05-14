'use strict';

const fs = require('fs').promises;
const path = require('path');
const { getTemplate } = require('./archetypeTemplates');

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

function normalizeBook(book, territory, slug) {
  if (!book || !book.title) return null;
  const id = book.bookId || book.id || slugify(book.title);
  return {
    id,
    teneoBookId: book.bookId || book.teneoBookId || null,
    title: book.title,
    subtitle: book.subtitle || '',
    author: book.author || territory.name,
    description: book.descriptionMd || book.description || book.impact || territory.mission.solution || '',
    longDescription: book.longDescription || book.descriptionMd || book.description || '',
    price: Number(book.priceUSD || book.price || 9.99),
    currency: 'USD',
    status: book.status || (book.bookId || book.teneoBookId ? 'live' : 'planned'),
    format: book.formats || ['digital'],
    coverImage: book.coverUrl || book.coverImage || `/brands/${slug}/assets/covers/${id}.jpg`,
    digitalFile: book.digitalFile || null,
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
      createdAt: new Date().toISOString(),
    },
  };
}

function upsertBook(books, book) {
  if (!book) return books;
  const index = books.findIndex((existing) => existing.id === book.id || existing.teneoBookId === book.teneoBookId);
  if (index >= 0) {
    const next = [...books];
    next[index] = { ...next[index], ...book, metadata: { ...(next[index].metadata || {}), ...(book.metadata || {}) } };
    return next;
  }
  return [book, ...books];
}

async function scaffoldStorefront(payload) {
  const territory = normalizeTerritory(payload);
  const slug = slugify(payload.slug || territory.slug || territory.territoryId || territory.name);
  const brandDir = assertSafeBrandSlug(slug);

  await fs.mkdir(path.join(brandDir, 'assets', 'covers'), { recursive: true });
  await fs.mkdir(path.join(brandDir, 'books'), { recursive: true });
  await fs.mkdir(path.join(brandDir, 'blog'), { recursive: true });

  const configPath = path.join(brandDir, 'config.json');
  const catalogPath = path.join(brandDir, 'catalog.json');
  const variablesPath = path.join(brandDir, 'variables.json');
  const existingConfig = await readJson(configPath, {});
  const existingCatalog = await readJson(catalogPath, {});

  const firstBook = normalizeBook(payload.firstBook, territory, slug);
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

  await writeJson(configPath, config);
  await writeJson(catalogPath, catalog);
  await writeJson(variablesPath, variables);

  const publicBase = process.env.PUBLIC_URL || process.env.FRONTEND_URL || 'https://openbazaar.ai';
  return {
    storefrontId: slug,
    slug,
    brandId: slug,
    publicUrl: `${publicBase.replace(/\/$/, '')}/store.html?brand=${encodeURIComponent(slug)}`,
    catalogUrl: `${publicBase.replace(/\/$/, '')}/brands/${encodeURIComponent(slug)}/catalog.json`,
    status: 'live',
    bookCount: catalog.books.length,
    primaryArchetype: config.territory.primaryArchetype,
  };
}

module.exports = {
  scaffoldStorefront,
  slugify,
};
