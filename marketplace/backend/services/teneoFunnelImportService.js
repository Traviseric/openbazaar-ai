'use strict';

const fs = require('fs').promises;
const path = require('path');

const EXPORT_SCHEMA = 'openbazaar.ai/funnel-export/v0.1';
const IMPORT_SCHEMA = 'openbazaar.ai/native-funnel-import/v0.1';

function slugify(value, fallback = 'teneo-funnel') {
  const slug = String(value || fallback)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);
  return slug || fallback;
}

function parsePriceCents(raw) {
  if (raw === null || raw === undefined || raw === '') return 0;
  const str = String(raw).replace(/[^0-9.]/g, '');
  const dollars = Number.parseFloat(str);
  if (Number.isNaN(dollars)) return 0;
  return Math.round(dollars * 100);
}

function parseManifest(input) {
  if (typeof input === 'string') {
    try {
      return JSON.parse(input);
    } catch (error) {
      throw new Error(`Invalid Teneo funnel manifest JSON: ${error.message}`);
    }
  }

  return input;
}

function assertObject(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`Manifest ${label} must be an object`);
  }
}

function validateManifest(input) {
  const manifest = parseManifest(input);
  assertObject(manifest, 'root');

  if (manifest.schemaVersion !== EXPORT_SCHEMA) {
    throw new Error(`Unsupported manifest schemaVersion: ${manifest.schemaVersion || 'missing'}`);
  }

  assertObject(manifest.source, 'source');
  assertObject(manifest.funnel, 'funnel');
  assertObject(manifest.offer, 'offer');
  assertObject(manifest.attribution, 'attribution');
  assertObject(manifest.analytics, 'analytics');
  assertObject(manifest.openBazaar, 'openBazaar');

  if (!manifest.funnel.id || !manifest.funnel.slug || !manifest.funnel.name) {
    throw new Error('Manifest funnel.id, funnel.slug, and funnel.name are required');
  }

  if (!Array.isArray(manifest.blocks) || manifest.blocks.length === 0) {
    throw new Error('Manifest blocks must be a non-empty array');
  }

  if (!Array.isArray(manifest.analytics.events) || manifest.analytics.events.length === 0) {
    throw new Error('Manifest analytics.events must be a non-empty array');
  }

  return manifest;
}

function findBlock(manifest, type) {
  return manifest.blocks.find((block) => block.type === type) || null;
}

function buildCourse(manifest) {
  const outline = findBlock(manifest, 'courseOutline');
  const modules = Array.isArray(outline?.modules) ? outline.modules : [];
  const slug = `${slugify(manifest.funnel.slug)}-course`;

  return {
    slug,
    title: outline?.title || `${manifest.funnel.name} Course`,
    description: findBlock(manifest, 'hero')?.body || manifest.offer.name || '',
    price_cents: parsePriceCents(manifest.offer.price),
    is_published: 1,
    modules: modules.map((module, index) => ({
      title: module.title || `Module ${index + 1}`,
      order_index: index,
      lessons: [
        {
          title: module.title || `Lesson ${index + 1}`,
          content_type: 'text',
          content_body: module.detail || '',
          order_index: 0,
          is_free_preview: index === 0 ? 1 : 0,
        },
      ],
    })),
  };
}

function buildFunnel(manifest) {
  const slug = slugify(manifest.funnel.slug);

  return {
    id: manifest.funnel.id,
    slug,
    name: manifest.funnel.name,
    status: 'published',
    template: `teneo-runtime:${slug}`,
    sourceRoute: manifest.funnel.route,
    previewRoute: manifest.funnel.previewRoute,
    runtimeModules: manifest.funnel.modules || [],
    theme: manifest.funnel.theme || {},
    blocks: manifest.blocks,
  };
}

function buildStorefront(manifest) {
  const storefront = manifest.openBazaar.storefront || {};
  const slug = slugify(storefront.slug || manifest.funnel.slug);

  return {
    slug,
    surface: manifest.openBazaar.surface,
    type: storefront.type || 'funnel_storefront',
    listingSeed: storefront.listingSeed || null,
    catalogSeed: storefront.catalogSeed || null,
    proofCounters: storefront.proofCounters || [],
    fulfillmentCallback: manifest.openBazaar.fulfillmentCallback || null,
  };
}

function buildCheckout(manifest) {
  return {
    productId: manifest.offer.id,
    productName: manifest.offer.name,
    productType: manifest.offer.openBazaarProductType,
    price: manifest.offer.price,
    price_cents: parsePriceCents(manifest.offer.price),
    checkoutRoute: manifest.offer.checkoutRoute,
    successRoute: manifest.offer.successRoute,
    preserveParams: manifest.attribution.preserveParams || [],
    metadataKeys: manifest.attribution.checkoutMetadata || [],
  };
}

function buildNativeImport(input) {
  const manifest = validateManifest(input);

  return {
    schemaVersion: IMPORT_SCHEMA,
    sourceManifest: {
      schemaVersion: manifest.schemaVersion,
      system: manifest.source.system,
      client: manifest.source.client,
      runtimeVersion: manifest.source.runtimeVersion,
      sourceDoc: manifest.source.sourceDoc,
      definitionPath: manifest.source.definitionPath || null,
    },
    funnel: buildFunnel(manifest),
    course: buildCourse(manifest),
    storefront: buildStorefront(manifest),
    checkout: buildCheckout(manifest),
    observability: {
      eventFamily: manifest.analytics.eventFamily,
      events: manifest.analytics.events,
      requiredBeforePaidTraffic: manifest.analytics.requiredBeforePaidTraffic || [],
    },
    attribution: manifest.attribution,
  };
}

async function loadManifest(filePath) {
  return validateManifest(await fs.readFile(filePath, 'utf8'));
}

async function writeNativeImport(nativeImport, options = {}) {
  const outDir = path.resolve(options.outDir || path.join(__dirname, '..', '..', '..', 'funnel-module', 'imports', 'teneo'));
  const filePath = path.join(outDir, `${nativeImport.funnel.slug}.json`);
  await fs.mkdir(outDir, { recursive: true });
  await fs.writeFile(filePath, `${JSON.stringify(nativeImport, null, 2)}\n`);
  return filePath;
}

function dbRun(db, sql, params) {
  return new Promise((resolve, reject) => {
    db.run(sql, params, function onRun(err) {
      if (err) reject(err);
      else resolve(this);
    });
  });
}

function dbGet(db, sql, params) {
  return new Promise((resolve, reject) => {
    db.get(sql, params, (err, row) => {
      if (err) reject(err);
      else resolve(row);
    });
  });
}

async function upsertFunnel(db, nativeImport, brandId, userId) {
  const existing = await dbGet(db, 'SELECT id FROM funnels WHERE slug = ? AND brand_id = ?', [
    nativeImport.funnel.slug,
    brandId,
  ]);

  if (existing) {
    await dbRun(db, 'UPDATE funnels SET name = ?, status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?', [
      nativeImport.funnel.name,
      nativeImport.funnel.status,
      existing.id,
    ]);
    return existing.id;
  }

  const result = await dbRun(
    db,
    'INSERT INTO funnels (brand_id, name, slug, status, user_id) VALUES (?, ?, ?, ?, ?)',
    [brandId, nativeImport.funnel.name, nativeImport.funnel.slug, nativeImport.funnel.status, userId || null]
  );
  return result.lastID;
}

async function upsertFunnelDraft(db, nativeImport, userId) {
  await dbRun(
    db,
    `INSERT INTO funnel_drafts (user_id, funnel_name, template, variables, context, updated_at)
     VALUES (?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
     ON CONFLICT(user_id, funnel_name)
     DO UPDATE SET template = excluded.template, variables = excluded.variables,
                   context = excluded.context, updated_at = CURRENT_TIMESTAMP`,
    [
      userId,
      nativeImport.funnel.name,
      nativeImport.funnel.template,
      JSON.stringify({
        blocks: nativeImport.funnel.blocks,
        theme: nativeImport.funnel.theme,
        checkout: nativeImport.checkout,
        attribution: nativeImport.attribution,
        observability: nativeImport.observability,
        storefront: nativeImport.storefront,
      }),
      JSON.stringify(nativeImport.sourceManifest),
    ]
  );
}

async function upsertCourse(db, nativeImport, brandId) {
  const course = nativeImport.course;
  const existing = await dbGet(db, 'SELECT id FROM courses WHERE slug = ?', [course.slug]);

  let courseId;
  if (existing) {
    await dbRun(
      db,
      `UPDATE courses
       SET brand_id = ?, title = ?, description = ?, price_cents = ?, is_published = ?, updated_at = CURRENT_TIMESTAMP
       WHERE id = ?`,
      [brandId, course.title, course.description, course.price_cents, course.is_published, existing.id]
    );
    courseId = existing.id;
  } else {
    const result = await dbRun(
      db,
      'INSERT INTO courses (brand_id, title, slug, description, price_cents, is_published) VALUES (?, ?, ?, ?, ?, ?)',
      [brandId, course.title, course.slug, course.description, course.price_cents, course.is_published]
    );
    courseId = result.lastID;
  }

  for (const [moduleIndex, module] of course.modules.entries()) {
    const moduleResult = await dbRun(db, 'INSERT INTO course_modules (course_id, title, order_index) VALUES (?, ?, ?)', [
      courseId,
      module.title,
      module.order_index ?? moduleIndex,
    ]);

    for (const [lessonIndex, lesson] of module.lessons.entries()) {
      await dbRun(
        db,
        `INSERT INTO course_lessons
         (module_id, title, content_type, content_body, order_index, is_free_preview)
         VALUES (?, ?, ?, ?, ?, ?)`,
        [
          moduleResult.lastID,
          lesson.title,
          lesson.content_type,
          lesson.content_body,
          lesson.order_index ?? lessonIndex,
          lesson.is_free_preview ? 1 : 0,
        ]
      );
    }
  }

  return courseId;
}

async function importToDatabase(nativeImport, db, options = {}) {
  const brandId = options.brandId || nativeImport.storefront.slug || 'teneo';
  const userId = options.userId || 'teneo-import';
  const funnelId = await upsertFunnel(db, nativeImport, brandId, userId);
  await upsertFunnelDraft(db, nativeImport, userId);
  const courseId = await upsertCourse(db, nativeImport, brandId);

  return {
    funnelId,
    courseId,
    brandId,
    userId,
    storefront: nativeImport.storefront,
    checkout: nativeImport.checkout,
    events: nativeImport.observability.events,
  };
}

module.exports = {
  EXPORT_SCHEMA,
  IMPORT_SCHEMA,
  buildNativeImport,
  importToDatabase,
  loadManifest,
  parsePriceCents,
  validateManifest,
  writeNativeImport,
};
