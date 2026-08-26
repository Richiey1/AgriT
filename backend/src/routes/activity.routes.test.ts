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

  it.each(['weeding', 'unknown', 'PLANTING'])('rejects unknown event type %s with 400', async (type) => {
    const res = await app.inject({
      method: 'POST',
      url: '/activities',
      payload: { farmer_id: 'farmer-1', type, date: '2026-08-01' },
    });

    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({ e: 1 });
  });

  it('rejects a missing or malformed date with 400', async () => {
    const missing = await app.inject({
      method: 'POST',
      url: '/activities',
      payload: { farmer_id: 'farmer-1', type: 'harvest' },
    });
    expect(missing.statusCode).toBe(400);

    const bad = await app.inject({
      method: 'POST',
      url: '/activities',
      payload: { farmer_id: 'farmer-1', type: 'harvest', date: 'not-a-date' },
    });
    expect(bad.statusCode).toBe(400);
  });

  it('rejects a missing farmer id with 400', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/activities',
      payload: { type: 'sale', date: '2026-08-01' },
    });
    expect(res.statusCode).toBe(400);
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
