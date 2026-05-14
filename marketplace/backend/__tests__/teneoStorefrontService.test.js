'use strict';

const fs = require('fs').promises;
const os = require('os');
const path = require('path');
const express = require('express');
const request = require('supertest');

const { getTemplate } = require('../services/archetypeTemplates');

const medicalTerritory = {
  territoryId: 'medical',
  name: 'Medical Sovereignty',
  tagline: 'End Medical Debt. Expose Healthcare Fraud.',
  icon: '🏥',
  domain: 'health-sovereignty',
  capabilityRestored: 'Medical self-advocacy',
  readerTransformation: 'From overwhelmed patient to confident negotiator',
  businessArchetypes: ['KDP_CATALOG', 'AUTHORITY_BRAND', 'SERVICE_BUSINESS'],
  publishingCodeFlags: ['health-uncertainty', 'legal-uncertainty'],
  mission: {
    problem: 'Opaque bills',
    solution: 'Audit and appeal',
    impact: 'Reduce debt',
  },
  roadmapBooks: [{ id: 'med-1', title: 'The Hospital Bill Eraser' }],
};

const baseClaim = {
  claimId: 'clm_test_001',
  authorUserId: 'us-west-2:user-abc',
};

// Mock brandStore globally — every scaffoldStorefront() call writes to the
// DB-backed brand store first (authoritative), then best-effort to FS. Tests
// inspect both: brandStoreMock for the canonical write, tempDir for FS.
// Variable name must start with `mock` for jest.mock to allow referencing it.
const mockBrandStoreUpsert = jest.fn(async (record) => ({ ...record, createdAt: '2026-05-14T00:00:00Z', updatedAt: '2026-05-14T00:00:00Z' }));
const mockBrandStoreGetBySlug = jest.fn(async () => null);

jest.mock('../services/brandStore', () => ({
  upsert: (...args) => mockBrandStoreUpsert(...args),
  getBySlug: (...args) => mockBrandStoreGetBySlug(...args),
  listByTerritory: jest.fn(async () => []),
  setStatus: jest.fn(),
}));

describe('teneoStorefrontService', () => {
  let tempDir;
  let originalFetch;

  beforeEach(async () => {
    jest.resetModules();
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ob-storefront-'));
    process.env.MARKETPLACE_BRANDS_DIR = tempDir;
    process.env.PUBLIC_URL = 'https://openbazaar.test';
    originalFetch = global.fetch;
    mockBrandStoreUpsert.mockClear();
    mockBrandStoreGetBySlug.mockClear();
    mockBrandStoreGetBySlug.mockResolvedValue(null);
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
    global.fetch = originalFetch;
    delete process.env.MARKETPLACE_BRANDS_DIR;
    delete process.env.PUBLIC_URL;
  });

  async function readBrand(slug, filename) {
    return JSON.parse(
      await fs.readFile(path.join(tempDir, slug, filename), 'utf8')
    );
  }

  // -------------------------------------------------------------------------
  // Happy path
  // -------------------------------------------------------------------------

  test('scaffolds brand config and seeded catalog from territory payload', async () => {
    const service = require('../services/teneoStorefrontService');

    const result = await service.scaffoldStorefront({
      territory: {
        territoryId: 'medical',
        name: 'Medical Sovereignty',
        tagline: 'End Medical Debt',
        businessArchetypes: ['AUTHORITY_BRAND'],
        publishingCodeFlags: ['health-uncertainty'],
        mission: {
          problem: 'Opaque bills',
          solution: 'Audit and appeal',
          impact: 'Reduce debt',
        },
        roadmapBooks: [{ id: 'med-1', title: 'The Hospital Bill Eraser' }],
      },
      audience: { primary: ['Patients with medical debt'] },
      firstBook: { id: 'med-1', title: 'The Hospital Bill Eraser', priceUSD: 9.99 },
    });

    const config = await readBrand('medical', 'config.json');
    const catalog = await readBrand('medical', 'catalog.json');

    expect(result.slug).toBe('medical');
    expect(result.publicUrl).toBe('https://openbazaar.test/store/store.html?brand=medical');
    expect(config.territory.territoryId).toBe('medical');
    expect(config.territory.publishingCodeFlags).toEqual(['health-uncertainty']);
    expect(catalog.books).toHaveLength(1);
    expect(catalog.books[0].title).toBe('The Hospital Bill Eraser');
  });

  test('primary archetype skips KDP_CATALOG and picks the next entry', async () => {
    const service = require('../services/teneoStorefrontService');
    await service.scaffoldStorefront({ territory: medicalTerritory, claim: baseClaim });
    const config = await readBrand('medical', 'config.json');
    expect(config.territory.primaryArchetype).toBe('AUTHORITY_BRAND');
  });

  test('archetype template drives theme + features + copy', async () => {
    const service = require('../services/teneoStorefrontService');
    await service.scaffoldStorefront({
      territory: {
        ...medicalTerritory,
        territoryId: 'service-medical',
        businessArchetypes: ['SERVICE_BUSINESS'],
      },
      claim: baseClaim,
    });
    const config = await readBrand('service-medical', 'config.json');
    const template = getTemplate('SERVICE_BUSINESS');

    expect(config.theme.primaryColor).toBe(template.theme.primaryColor);
    expect(config.theme.headingFont).toBe(template.theme.headingFont);
    expect(config.features.booking).toBe(true);
    expect(config.features.leadCapture).toBe(true);
    expect(config.copy.ctaButton).toBe('Book a Consultation');
  });

  test('publishing code flags produce a flag-specific disclaimer', async () => {
    const service = require('../services/teneoStorefrontService');
    await service.scaffoldStorefront({ territory: medicalTerritory, claim: baseClaim });
    const config = await readBrand('medical', 'config.json');
    expect(config.legal.disclaimer).toMatch(/medical advice/i);
    expect(config.legal.disclaimer).toMatch(/legal advice/i);
  });

  test('writes css/theme.css that scopes archetype theme to body.{slug}-theme', async () => {
    const service = require('../services/teneoStorefrontService');
    await service.scaffoldStorefront({ territory: medicalTerritory, claim: baseClaim });
    const css = await fs.readFile(path.join(tempDir, 'medical', 'css', 'theme.css'), 'utf8');
    const template = getTemplate('AUTHORITY_BRAND');
    expect(css).toContain('body.medical-theme');
    expect(css).toContain('--brand-primary-color');
    expect(css).toContain(template.theme.primaryColor);
    expect(css).toContain(template.theme.headingFont);
  });

  // -------------------------------------------------------------------------
  // DB-backed authoritative write — survives serverless read-only FS
  // -------------------------------------------------------------------------

  test('writes brand record to DB-backed brandStore as authoritative source', async () => {
    const service = require('../services/teneoStorefrontService');
    await service.scaffoldStorefront({
      territory: medicalTerritory,
      claim: baseClaim,
      firstBook: { bookId: 'book-1', title: 'First Book', priceUSD: 9.99 },
    });

    expect(mockBrandStoreUpsert).toHaveBeenCalledTimes(1);
    const written = mockBrandStoreUpsert.mock.calls[0][0];
    expect(written.slug).toBe('medical');
    expect(written.territoryId).toBe('medical');
    expect(written.archetype).toBe('AUTHORITY_BRAND');
    expect(written.config.brand).toBe('medical');
    expect(written.config.name).toBe('Medical Sovereignty');
    expect(written.catalog.books).toHaveLength(1);
    expect(written.themeCss).toContain('body.medical-theme');
    expect(written.publishingCodeFlags).toEqual(medicalTerritory.publishingCodeFlags);
    expect(written.publicUrl).toContain('/store/store.html?brand=medical');
    expect(written.catalogUrl).toContain('/api/storefront/brands/medical/catalog.json');
    expect(written.status).toBe('live');
  });

  test('public URL points at /store/store.html (matches Vercel routes), not legacy /store.html', async () => {
    const service = require('../services/teneoStorefrontService');
    const result = await service.scaffoldStorefront({ territory: medicalTerritory, claim: baseClaim });
    expect(result.publicUrl).toMatch(/\/store\/store\.html\?brand=medical/);
    expect(result.publicUrl).not.toMatch(/openbazaar\.test\/store\.html/);
  });

  test('catalog URL points at /api/storefront/brands (DB-served, not FS)', async () => {
    const service = require('../services/teneoStorefrontService');
    const result = await service.scaffoldStorefront({ territory: medicalTerritory, claim: baseClaim });
    expect(result.catalogUrl).toMatch(/\/api\/storefront\/brands\/medical\/catalog\.json/);
  });

  test('normalizes public base URL from environment before returning URLs', async () => {
    process.env.PUBLIC_URL = ' https://openbazaar.test/\r\n';
    jest.resetModules();
    const service = require('../services/teneoStorefrontService');

    const result = await service.scaffoldStorefront({ territory: medicalTerritory, claim: baseClaim });

    expect(result.publicUrl).toBe('https://openbazaar.test/store/store.html?brand=medical');
    expect(result.catalogUrl).toBe('https://openbazaar.test/api/storefront/brands/medical/catalog.json');
  });

  test('scaffold succeeds even when filesystem is read-only (EROFS)', async () => {
    // Simulate @vercel/node read-only FS by pointing the brand dir at a
    // path the process cannot write to. The scaffolder should swallow the
    // EROFS/EACCES error from the best-effort FS writes and return success.
    process.env.MARKETPLACE_BRANDS_DIR = '/proc/1/root/__readonly_brands__';
    jest.resetModules();
    const service = require('../services/teneoStorefrontService');

    const result = await service.scaffoldStorefront({
      territory: medicalTerritory,
      claim: baseClaim,
    });

    expect(result.slug).toBe('medical');
    expect(result.status).toBe('live');
    // DB write still happened — that's the authoritative path
    expect(mockBrandStoreUpsert).toHaveBeenCalledTimes(1);
  });

  test('re-running uses existing DB row as base when FS is empty', async () => {
    // First call writes to DB (mocked) — capture what was written
    const service = require('../services/teneoStorefrontService');
    await service.scaffoldStorefront({
      territory: medicalTerritory,
      claim: baseClaim,
      firstBook: { bookId: 'book-1', title: 'First Book', priceUSD: 9.99 },
    });
    const firstCall = mockBrandStoreUpsert.mock.calls[0][0];

    // Second call: simulate DB returning the first record (as it would
    // in prod with a real Postgres). FS is fresh tempDir with no folder.
    mockBrandStoreGetBySlug.mockResolvedValueOnce({
      slug: firstCall.slug,
      config: firstCall.config,
      catalog: firstCall.catalog,
    });

    const result = await service.scaffoldStorefront({
      territory: medicalTerritory,
      claim: baseClaim,
      firstBook: { bookId: 'book-2', title: 'Second Book', priceUSD: 14.99 },
    });

    expect(result.bookCount).toBe(2);
    const secondWrite = mockBrandStoreUpsert.mock.calls[1][0];
    const titles = secondWrite.catalog.books.map((b) => b.title);
    expect(titles).toEqual(expect.arrayContaining(['First Book', 'Second Book']));
  });

  test('unknown archetype falls through to AUTHORITY_BRAND defaults', async () => {
    const service = require('../services/teneoStorefrontService');
    await service.scaffoldStorefront({
      territory: {
        ...medicalTerritory,
        territoryId: 'fallback',
        businessArchetypes: ['NONSENSE_ARCHETYPE'],
      },
      claim: baseClaim,
    });
    const config = await readBrand('fallback', 'config.json');
    const fallback = getTemplate('AUTHORITY_BRAND');
    expect(config.theme.primaryColor).toBe(fallback.theme.primaryColor);
    expect(config.copy.ctaButton).toBe('Read the Books');
  });

  // -------------------------------------------------------------------------
  // Idempotency
  // -------------------------------------------------------------------------

  test('re-running merges a new firstBook into the existing catalog', async () => {
    const service = require('../services/teneoStorefrontService');
    const payload = {
      territory: medicalTerritory,
      claim: baseClaim,
      firstBook: { bookId: 'book-1', title: 'First Book', priceUSD: 9.99 },
    };
    await service.scaffoldStorefront(payload);
    const second = await service.scaffoldStorefront({
      ...payload,
      firstBook: { bookId: 'book-2', title: 'Second Book', priceUSD: 12.99 },
    });

    expect(second.slug).toBe('medical');
    expect(second.bookCount).toBe(2);
    const catalog = await readBrand('medical', 'catalog.json');
    expect(catalog.books.map((b) => b.title)).toEqual(
      expect.arrayContaining(['First Book', 'Second Book'])
    );
  });

  test('re-running with the same book id replaces the entry instead of duplicating', async () => {
    const service = require('../services/teneoStorefrontService');
    const payload = {
      territory: medicalTerritory,
      claim: baseClaim,
      firstBook: { bookId: 'book-1', title: 'Original Title', priceUSD: 9.99 },
    };
    await service.scaffoldStorefront(payload);
    const second = await service.scaffoldStorefront({
      ...payload,
      firstBook: { bookId: 'book-1', title: 'Revised Title', priceUSD: 14.99 },
    });

    expect(second.bookCount).toBe(1);
    const catalog = await readBrand('medical', 'catalog.json');
    expect(catalog.books[0].title).toBe('Revised Title');
    expect(catalog.books[0].price).toBe(14.99);
  });

  test('finalized planned book upgrades the roadmap entry in place', async () => {
    global.fetch = jest.fn(async (url) => ({
      ok: true,
      headers: {
        get: (name) => {
          if (name === 'content-type' && url.endsWith('.epub')) return 'application/epub+zip';
          if (name === 'content-type' && url.endsWith('.pdf')) return 'application/pdf';
          if (name === 'content-length') return '12';
          return null;
        },
      },
      arrayBuffer: async () => Buffer.from(`asset:${url}`).buffer,
    }));
    const service = require('../services/teneoStorefrontService');
    await service.scaffoldStorefront({
      territory: medicalTerritory,
      claim: baseClaim,
      firstBook: { id: 'med-1', plannedBookId: 'med-1', title: 'The Hospital Bill Eraser' },
    });

    const second = await service.scaffoldStorefront({
      territory: medicalTerritory,
      claim: baseClaim,
      firstBook: {
        id: 'med-1',
        plannedBookId: 'med-1',
        bookId: 'full-book-123',
        teneoBookId: 'full-book-123',
        title: 'The Hospital Bill Eraser',
        status: 'live',
        formats: [
          { type: 'epub', url: 'https://cdn.test/book.epub', s3Source: 's3://book-final-bucket/book.epub' },
          { type: 'pdf', url: 'https://cdn.test/book.pdf', s3Source: 's3://book-final-bucket/book.pdf' },
        ],
      },
    });

    expect(second.bookCount).toBe(1);
    const catalog = await readBrand('medical', 'catalog.json');
    expect(catalog.books).toHaveLength(1);
    expect(catalog.books[0].id).toBe('med-1');
    expect(catalog.books[0].teneoBookId).toBe('full-book-123');
    expect(catalog.books[0].status).toBe('live');
    expect(catalog.books[0].formats.map((format) => format.type)).toEqual(['epub', 'pdf']);
    expect(catalog.books[0].digitalFile.type).toBe('epub');
    expect(catalog.books[0].formats[0].url).toBe('/brands/medical/books/med-1/epub.epub');
    expect(catalog.books[0].formats[1].url).toBe('/brands/medical/books/med-1/pdf.pdf');
    await expect(fs.readFile(path.join(tempDir, 'medical', 'books', 'med-1', 'epub.epub'))).resolves.toBeTruthy();
    await expect(fs.readFile(path.join(tempDir, 'medical', 'books', 'med-1', 'pdf.pdf'))).resolves.toBeTruthy();
  });

  // -------------------------------------------------------------------------
  // Failure modes
  // -------------------------------------------------------------------------

  test('rejects payload missing territoryId', async () => {
    const service = require('../services/teneoStorefrontService');
    await expect(
      service.scaffoldStorefront({ territory: { name: 'no id' } })
    ).rejects.toMatchObject({ statusCode: 400 });
  });

  test('slugify sanitizes path-traversal attempts to safe slugs', async () => {
    const service = require('../services/teneoStorefrontService');
    const result = await service.scaffoldStorefront({
      slug: '../../escape',
      territory: medicalTerritory,
    });
    expect(result.slug).toBe('escape');
    expect(result.slug).not.toMatch(/[./\\]/);
    const config = await readBrand('escape', 'config.json');
    expect(config.brand).toBe('escape');
  });
});

// ---------------------------------------------------------------------------
// Route integration
// ---------------------------------------------------------------------------

describe('POST /api/ai-invoke/marketplace.create-storefront', () => {
  let app;
  let tempDir;

  beforeEach(async () => {
    jest.resetModules();
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ob-create-store-'));
    process.env.MARKETPLACE_BRANDS_DIR = tempDir;
    process.env.PUBLIC_URL = 'https://openbazaar.test';
    process.env.TENEO_SERVICE_KEYS = 'test-service-key';
    const aiInvokeRouter = require('../routes/aiInvoke');
    app = express();
    app.use(express.json());
    app.use('/api/ai-invoke', aiInvokeRouter);
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
    delete process.env.MARKETPLACE_BRANDS_DIR;
    delete process.env.PUBLIC_URL;
    delete process.env.TENEO_SERVICE_KEYS;
  });

  test('rejects requests without a valid service key', async () => {
    const res = await request(app)
      .post('/api/ai-invoke/marketplace.create-storefront')
      .send({ territory: medicalTerritory });
    expect(res.status).toBe(401);
  });

  test('returns storefront descriptor on a valid scaffold request', async () => {
    const res = await request(app)
      .post('/api/ai-invoke/marketplace.create-storefront')
      .set('x-service-key', 'test-service-key')
      .send({
        territory: medicalTerritory,
        claim: baseClaim,
        firstBook: { bookId: 'book-1', title: 'First Book' },
      });

    expect(res.status).toBe(200);
    expect(res.body.slug).toBe('medical');
    expect(res.body.publicUrl).toContain('brand=medical');
    expect(res.body.catalogUrl).toContain('/brands/medical/catalog.json');
    expect(res.body.primaryArchetype).toBe('AUTHORITY_BRAND');
  });

  test('returns 400 when territory.territoryId is missing', async () => {
    const res = await request(app)
      .post('/api/ai-invoke/marketplace.create-storefront')
      .set('x-service-key', 'test-service-key')
      .send({ territory: { name: 'no id' } });
    expect(res.status).toBe(400);
  });
});
