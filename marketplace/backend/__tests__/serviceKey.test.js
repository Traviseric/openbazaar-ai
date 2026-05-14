'use strict';

describe('service-key middleware', () => {
  beforeEach(() => {
    jest.resetModules();
    process.env.TENEO_SERVICE_KEYS = 'test-service-key,another-key';
  });

  test('rejects missing service key', () => {
    const { requireServiceKey } = require('../middleware/serviceKey');
    const req = { headers: {} };
    const res = {
      status: jest.fn().mockReturnThis(),
      json: jest.fn(),
    };
    const next = jest.fn();

    requireServiceKey(req, res, next);

    expect(res.status).toHaveBeenCalledWith(401);
    expect(next).not.toHaveBeenCalled();
  });

  test('accepts configured service key', () => {
    const { requireServiceKey } = require('../middleware/serviceKey');
    const req = { headers: { 'x-service-key': 'test-service-key' } };
    const res = {
      status: jest.fn().mockReturnThis(),
      json: jest.fn(),
    };
    const next = jest.fn();

    requireServiceKey(req, res, next);

    expect(req.serviceKeyAuthenticated).toBe(true);
    expect(next).toHaveBeenCalled();
  });
});
