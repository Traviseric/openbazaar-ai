'use strict';

const fs = require('fs');
const path = require('path');

describe('store.html lead capture integration', () => {
  const storeHtml = fs.readFileSync(
    path.join(__dirname, '..', '..', 'frontend', 'store.html'),
    'utf8'
  );

  test('renders a lead capture mount point and email form controls', () => {
    expect(storeHtml).toContain('data-lead-capture');
    expect(storeHtml).toContain('id="lead-capture-form"');
    expect(storeHtml).toContain('type="email"');
    expect(storeHtml).toContain('id="lead-capture-honeypot"');
  });

  test('submits to the Teneo-provided endpointUrl with payload defaults', () => {
    expect(storeHtml).toContain('leadCapture.endpointUrl');
    expect(storeHtml).toContain('leadCapture.payloadDefaults');
    expect(storeHtml).toContain("brandSlug: BRAND_ID");
    expect(storeHtml).toContain('fetch(leadCapture.endpointUrl');
  });
});
