import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import Fastify from 'fastify';
import { registerActivityRoutes } from './activity.routes.js';

function buildApp() {
  const app = Fastify();
  app.register(registerActivityRoutes);
  return app;
}

describe('POST /activities (USSD activity logging)', () => {
  let app: ReturnType<typeof buildApp>;

  beforeEach(async () => {
    app = buildApp();
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
  });

  it('accepts a valid event and answers with a compact body', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/activities',
      payload: { farmer_id: 'farmer-1', type: 'planting', date: '2026-08-01' },
    });

    expect(res.statusCode).toBe(201);
    expect(res.json()).toEqual({ ok: 1, id: 1 });
  });

  it('accepts an optional amount and stores it for scoring', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/activities',
      payload: { farmer_id: 'farmer-amt', type: 'planting', date: '2026-08-01', amount: 2500 },
    });
    expect(res.statusCode).toBe(201);

    const listing = await app.inject({ method: 'GET', url: '/farmers/farmer-amt/activities' });
    const body = listing.json();
    expect(body.activities[0].amt).toBe(2500);
  });

  it('rejects a negative amount with 400 (error code 4)', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/activities',
      payload: { farmer_id: 'farmer-1', type: 'sale', date: '2026-08-01', amount: -5 },
    });

    expect(res.statusCode).toBe(400);
    expect(res.json().e).toBe(4);
  });

  it.each(['weeding', 'unknown', 'PLANTING'])('rejects unknown event type %s with 400', async (type) => {
    const res = await app.inject({
      method: 'POST',
      url: '/activities',
      payload: { farmer_id: 'farmer-1', type, date: '2026-08-01' },
    });

    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ e: 1 });
  });

  it('rejects a missing or malformed date with 400', async () => {
    const missing = await app.inject({
      method: 'POST',
      url: '/activities',
      payload: { farmer_id: 'farmer-1', type: 'harvest' },
    });
    expect(missing.statusCode).toBe(400);
    expect(missing.json().e).toBe(2);

    const bad = await app.inject({
      method: 'POST',
      url: '/activities',
      payload: { farmer_id: 'farmer-1', type: 'harvest', date: 'not-a-date' },
    });
    expect(bad.statusCode).toBe(400);
    expect(bad.json().e).toBe(2);
  });

  it.each(['08/01/2026', '2026', '2026-13-40', '2026-08-01T00:00:00Z'])(
    'rejects non-ISO date %s with 400',
    async (date) => {
      const res = await app.inject({
        method: 'POST',
        url: '/activities',
        payload: { farmer_id: 'farmer-1', type: 'harvest', date },
      });
      expect(res.statusCode).toBe(400);
      expect(res.json().e).toBe(2);
    }
  );

  it('rejects a missing farmer id with 400 (error code 3)', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/activities',
      payload: { type: 'sale', date: '2026-08-01' },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().e).toBe(3);
  });

  it('stores events per farmer so scoring can query them later', async () => {
    await app.inject({
      method: 'POST',
      url: '/activities',
      payload: { farmer_id: 'farmer-2', type: 'planting', date: '2026-07-01' },
    });
    await app.inject({
      method: 'POST',
      url: '/activities',
      payload: { farmer_id: 'farmer-2', type: 'harvest', date: '2026-08-01' },
    });

    const res = await app.inject({ method: 'GET', url: '/farmers/farmer-2/activities' });
    expect(res.statusCode).toBe(200);

    const body = res.json();
    expect(body.count).toBe(2);
    expect(body.activities.map((a: any) => a.t)).toEqual(['planting', 'harvest']);
  });

  it('keeps farmers isolated — events never leak across farmer ids', async () => {
    await app.inject({
      method: 'POST',
      url: '/activities',
      payload: { farmer_id: 'farmer-a', type: 'sale', date: '2026-08-01' },
    });

    const res = await app.inject({ method: 'GET', url: '/farmers/farmer-b/activities' });
    expect(res.json().count).toBe(0);
  });
});
