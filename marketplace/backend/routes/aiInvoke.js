'use strict';

const express = require('express');
const router = express.Router();
const { requireServiceKey } = require('../middleware/serviceKey');
const listingService = require('../services/teneoListingService');
const teneoStorefrontService = require('../services/teneoStorefrontService');

router.use(requireServiceKey);

router.post('/marketplace.publish-book', async (req, res) => {
  try {
    const listing = await listingService.publishBook(req.body || {});
    res.json({
      listingId: listing.listingId,
      slug: listing.slug,
      publicUrl: listing.publicUrl,
      status: listing.status,
    });
  } catch (error) {
    res.status(error.statusCode || 500).json({
      success: false,
      error: error.statusCode ? error.message : 'Failed to publish listing',
    });
  }
});

router.post('/marketplace.create-storefront', async (req, res) => {
  try {
    const storefront = await teneoStorefrontService.scaffoldStorefront(req.body || {});
    res.json(storefront);
  } catch (error) {
    res.status(error.statusCode || 500).json({
      success: false,
      error: error.statusCode ? error.message : 'Failed to scaffold storefront',
    });
  }
});

router.post('/marketplace.update-listing', async (req, res) => {
  try {
    const { listingId, patch } = req.body || {};
    if (!listingId || !patch || typeof patch !== 'object') {
      return res.status(400).json({ success: false, error: 'listingId and patch are required' });
    }
    const listing = await listingService.updateListing(listingId, patch);
    if (!listing) return res.status(404).json({ success: false, error: 'Listing not found' });
    res.json({ listingId: listing.listingId, status: listing.status });
  } catch {
    res.status(500).json({ success: false, error: 'Failed to update listing' });
  }
});

router.post('/marketplace.unpublish', async (req, res) => {
  try {
    const { listingId, reason } = req.body || {};
    if (!listingId) return res.status(400).json({ success: false, error: 'listingId is required' });
    const listing = await listingService.unpublish(listingId, reason);
    if (!listing) return res.status(404).json({ success: false, error: 'Listing not found' });
    res.json({ listingId: listing.listingId, status: listing.status });
  } catch {
    res.status(500).json({ success: false, error: 'Failed to unpublish listing' });
  }
});

router.get('/marketplace.get-stats', async (req, res) => {
  try {
    const stats = await listingService.getStats(req.query.listingId || null);
    if (!stats) return res.status(404).json({ success: false, error: 'Listing not found' });
    res.json(stats);
  } catch {
    res.status(500).json({ success: false, error: 'Failed to load marketplace stats' });
  }
});

router.post('/marketplace.update-storefront', async (req, res) => {
  try {
    const { slug, patch, bookCount, status } = req.body || {};
    if (!slug) {
      return res.status(400).json({ success: false, error: 'slug is required' });
    }
    if (!patch || typeof patch !== 'object') {
      return res.status(400).json({ success: false, error: 'patch (object) is required' });
    }
    const brandStore = require('../services/brandStore');
    const opts = {};
    if (typeof bookCount === 'number') opts.bookCount = bookCount;
    if (status) opts.status = status;
    const brand = await brandStore.applyPatch(slug, patch, opts);
    res.json({
      slug: brand.slug,
      publicUrl: brand.publicUrl,
      catalogUrl: brand.catalogUrl,
      status: brand.status,
      updatedAt: brand.updatedAt,
    });
  } catch (error) {
    res.status(error.statusCode || 500).json({
      success: false,
      error: error.statusCode ? error.message : 'Failed to update storefront',
    });
  }
});

module.exports = router;
