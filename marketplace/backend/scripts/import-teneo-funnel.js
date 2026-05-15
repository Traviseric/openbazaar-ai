#!/usr/bin/env node
'use strict';

const path = require('path');

const {
  buildNativeImport,
  importToDatabase,
  loadManifest,
  writeNativeImport,
} = require('../services/teneoFunnelImportService');

function usage() {
  console.error('Usage: node marketplace/backend/scripts/import-teneo-funnel.js <manifest.json...> [--out <dir>] [--db] [--brand <brandId>] [--user <userId>]');
}

function parseArgs(argv) {
  const options = {
    manifestPaths: [],
    outDir: null,
    db: false,
    brandId: null,
    userId: null,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--db') {
      options.db = true;
    } else if (arg === '--out') {
      options.outDir = argv[++i];
    } else if (arg === '--brand') {
      options.brandId = argv[++i];
    } else if (arg === '--user') {
      options.userId = argv[++i];
    } else if (arg.startsWith('--')) {
      throw new Error(`Unknown option: ${arg}`);
    } else {
      options.manifestPaths.push(arg);
    }
  }

  if (options.manifestPaths.length === 0) {
    throw new Error('At least one manifest path is required');
  }

  return options;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const db = options.db ? require('../database/database') : null;

  for (const manifestPath of options.manifestPaths) {
    const resolvedPath = path.resolve(manifestPath);
    const manifest = await loadManifest(resolvedPath);
    const nativeImport = buildNativeImport(manifest);
    const artifactPath = await writeNativeImport(nativeImport, { outDir: options.outDir });

    console.log(`Wrote native import: ${path.relative(process.cwd(), artifactPath)}`);

    if (db) {
      const result = await importToDatabase(nativeImport, db, {
        brandId: options.brandId,
        userId: options.userId,
      });
      console.log(`Imported records: funnel=${result.funnelId} course=${result.courseId} brand=${result.brandId}`);
    }
  }
}

main().catch((error) => {
  usage();
  console.error(error.message);
  process.exit(1);
});
