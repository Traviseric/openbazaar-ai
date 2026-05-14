'use strict';

const fs = require('fs').promises;
const os = require('os');
const path = require('path');

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

    const config = JSON.parse(await fs.readFile(path.join(tempDir, 'medical', 'config.json'), 'utf8'));
    const catalog = JSON.parse(await fs.readFile(path.join(tempDir, 'medical', 'catalog.json'), 'utf8'));

    expect(result.slug).toBe('medical');
    expect(result.publicUrl).toBe('https://openbazaar.test/store.html?brand=medical');
    expect(config.territory.territoryId).toBe('medical');
    expect(config.territory.publishingCodeFlags).toEqual(['health-uncertainty']);
    expect(catalog.books).toHaveLength(1);
    expect(catalog.books[0].title).toBe('The Hospital Bill Eraser');
  });
});
