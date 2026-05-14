'use strict';

const axios = require('axios');

function enabled() {
  return Boolean(process.env.TENEO_PRODUCTION_API_URL && process.env.TENEO_PRODUCTION_SERVICE_KEY);
}

async function callCapability(capability, payload) {
  if (!enabled()) {
    return { skipped: true, reason: 'TENEO_PRODUCTION_API_URL or TENEO_PRODUCTION_SERVICE_KEY not configured' };
  }

  const baseUrl = process.env.TENEO_PRODUCTION_API_URL.replace(/\/+$/, '');
  const response = await axios.post(
    `${baseUrl}/api/ai-invoke/${capability}`,
    payload,
    {
      timeout: 15000,
      headers: {
        'content-type': 'application/json',
        'x-service-key': process.env.TENEO_PRODUCTION_SERVICE_KEY,
      },
    }
  );
  return response.data;
}

async function orderPaid(payload) {
  return callCapability('marketplace.order-paid', payload);
}

async function refund(payload) {
  return callCapability('marketplace.refund', payload);
}

async function creditAuthor(payload) {
  return callCapability('marketplace.credit-author', payload);
}

module.exports = {
  enabled,
  orderPaid,
  refund,
  creditAuthor,
};
