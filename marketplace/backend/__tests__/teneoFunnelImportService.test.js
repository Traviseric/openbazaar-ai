'use strict';

const {
  buildNativeImport,
  importToDatabase,
  parsePriceCents,
  validateManifest,
} = require('../services/teneoFunnelImportService');

const TENEO_MANIFEST = {
  schemaVersion: 'openbazaar.ai/funnel-export/v0.1',
  source: {
    system: 'teneo',
    client: 'teneo-production',
    runtimeVersion: '2026-05-14-preview-1',
    sourceDoc: 'docs/marketing/funnels/TENEO-CLICKFUNNELS-FUNNEL-BLUEPRINT.md',
    definitionPath: 'React/book-generator/src/data/funnelDefinitions.js',
  },
  funnel: {
    id: 'ten-minute-author',
    slug: 'ten-minute-author',
    name: '10-Minute Author',
    route: '/10-minute-author',
    previewRoute: '/funnels/ten-minute-author/preview',
    exportType: 'funnel.course.storefront',
    modules: ['Hero', 'ProofRail', 'OfferStack', 'CourseOutline'],
    theme: { accent: 'author', image: '/examples/cover.png' },
  },
  offer: {
    id: 'first-book-starter',
    name: '$10 First Book Starter',
    checkoutRoute: '/signup/ten-dollar-offer?funnel=ten-minute-author',
    successRoute: '/welcome-author',
    price: '$10',
    openBazaarProductType: 'course_plus_generation_credit',
  },
  attribution: {
    preserveParams: ['funnel', 'source', 'utm_source', 'ref', 'affiliateId'],
    checkoutMetadata: ['funnelId', 'source', 'utm', 'ref', 'affiliateId', 'teneoSessionId'],
  },
  analytics: {
    eventFamily: 'funnel_observability',
    events: ['funnel_page_viewed', 'funnel_button_clicked', 'funnel_form_submitted'],
    requiredBeforePaidTraffic: ['page_view', 'primary_cta_click', 'checkout_started'],
  },
  blocks: [
    {
      id: 'hero',
      type: 'hero',
      headline: 'Turn a book idea into a publishable asset.',
      body: 'A focused first-book funnel for publishers.',
    },
    {
      id: 'course-outline',
      type: 'courseOutline',
      title: 'Course replacement path',
      modules: [
        { title: 'Choose the angle', detail: 'Lock the promise, reader, and first book outcome.' },
        { title: 'Generate the asset', detail: 'Move into Teneo with attribution intact.' },
      ],
    },
  ],
  openBazaar: {
    surface: 'marketplace.publish-book',
    storefront: {
      type: 'author_storefront',
      listingSeed: 'first_generated_book',
    },
    fulfillmentCallback: {
      owner: 'teneo',
      action: 'book_generation_then_listing_prompt',
    },
  },
};

describe('teneoFunnelImportService', () => {
  test('validates the Teneo export contract', () => {
    expect(validateManifest(TENEO_MANIFEST).funnel.slug).toBe('ten-minute-author');
    expect(() => validateManifest({ ...TENEO_MANIFEST, schemaVersion: 'unknown' })).toThrow('Unsupported manifest');
  });

  test('maps a Teneo manifest into native funnel, course, checkout, and storefront payloads', () => {
    const nativeImport = buildNativeImport(TENEO_MANIFEST);

    expect(nativeImport.schemaVersion).toBe('openbazaar.ai/native-funnel-import/v0.1');
    expect(nativeImport.funnel.template).toBe('teneo-runtime:ten-minute-author');
    expect(nativeImport.funnel.blocks).toHaveLength(2);
    expect(nativeImport.course.slug).toBe('ten-minute-author-course');
    expect(nativeImport.course.modules).toHaveLength(2);
    expect(nativeImport.course.modules[0].lessons[0].content_body).toContain('Lock the promise');
    expect(nativeImport.checkout.metadataKeys).toContain('teneoSessionId');
    expect(nativeImport.checkout.price_cents).toBe(1000);
    expect(nativeImport.storefront.surface).toBe('marketplace.publish-book');
    expect(nativeImport.storefront.listingSeed).toBe('first_generated_book');
    expect(nativeImport.observability.events).toContain('funnel_button_clicked');
  });

  test('parses prices consistently for DB-ready records', () => {
    expect(parsePriceCents('$197')).toBe(19700);
    expect(parsePriceCents('Free')).toBe(0);
    expect(parsePriceCents('9.99')).toBe(999);
  });

  test('imports mapped payloads into funnel draft and course tables', async () => {
    let idCounter = 1;
    const db = {
      get: jest.fn((sql, params, cb) => cb(null, null)),
      run: jest.fn((sql, params, cb) => cb.call({ lastID: idCounter++, changes: 1 }, null)),
    };

    const result = await importToDatabase(buildNativeImport(TENEO_MANIFEST), db, {
      brandId: 'teneo',
      userId: 'teneo-import-test',
    });

    expect(result.funnelId).toBe(1);
    expect(result.courseId).toBe(3);
    expect(result.events).toContain('funnel_form_submitted');

    const sql = db.run.mock.calls.map((call) => call[0]).join('\n');
    expect(sql).toContain('INSERT INTO funnels');
    expect(sql).toContain('INSERT INTO funnel_drafts');
    expect(sql).toContain('INSERT INTO courses');
    expect(sql).toContain('INSERT INTO course_modules');
    expect(sql).toContain('INSERT INTO course_lessons');
  });
});
