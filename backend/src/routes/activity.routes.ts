import type { FastifyInstance } from 'fastify';
import {
  isAllowedActivityType,
  isIsoDate,
  logActivity,
  getActivitiesForFarmer,
} from '../services/activity.service.js';

/**
 * Mobile/USSD-friendly activity logging (issue #6).
 *
 * Responses are intentionally tiny — a farmer's phone pays for every byte:
 *   success: {"ok":1,"id":7}
 *   failure: {"e":<code>,"detail":"reason"} — single numeric-code convention
 *            so USSD clients can branch on one field.
 *   error codes: 1 invalid type | 2 invalid/missing date | 3 missing farmer id
 *                4 invalid amount
 */
export async function registerActivityRoutes(fastify: FastifyInstance) {
  fastify.post<{
    Body: { farmer_id?: string; type?: string; date?: string; amount?: number };
  }>('/activities', async (request, reply) => {
    const { farmer_id, type, date, amount } = request.body ?? {};

    if (!farmer_id || typeof farmer_id !== 'string') {
      return reply.code(400).send({ e: 3, detail: 'farmer_id required' });
    }
    if (!type || !isAllowedActivityType(type)) {
      return reply.code(400).send({ e: 1, detail: 'unknown activity type' });
    }
    if (!date || typeof date !== 'string' || !isIsoDate(date)) {
      return reply.code(400).send({ e: 2, detail: 'date must be YYYY-MM-DD' });
    }
    if (amount !== undefined && (typeof amount !== 'number' || !Number.isFinite(amount) || amount < 0)) {
      return reply.code(400).send({ e: 4, detail: 'amount must be a non-negative number' });
    }

    const { id } = logActivity(farmer_id, type, date, amount ?? 0);
    return reply.code(201).send({ ok: 1, id });
  });

  fastify.get<{ Params: { farmerId: string } }>(
    '/farmers/:farmerId/activities',
    async (request, reply) => {
      const activities = getActivitiesForFarmer(request.params.farmerId);

      // Compact per-farmer listing for scoring and low-bandwidth reads.
      return reply.code(200).send({
        ok: 1,
        count: activities.length,
        activities: activities.map((a) => ({ t: a.type, ts: a.timestamp, amt: a.amount })),
      });
    }
  );
}
