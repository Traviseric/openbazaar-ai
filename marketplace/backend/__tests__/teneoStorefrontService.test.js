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

describe('teneoStorefrontService', () => {
  let tempDir;

  beforeEach(async () => {
    jest.resetModules();
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ob-storefront-'));
    process.env.MARKETPLACE_BRANDS_DIR = tempDir;
    process.env.PUBLIC_URL = 'https://openbazaar.test';
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
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
    expect(result.publicUrl).toBe('https://openbazaar.test/store.html?brand=medical');
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
