import type { FastifyInstance } from 'fastify';
import {
  isAllowedActivityType,
  logActivity,
  getActivitiesForFarmer,
} from '../services/activity.service.js';

/**
 * Mobile/USSD-friendly activity logging (issue #6).
 *
 * Responses are intentionally tiny — a farmer's phone pays for every byte:
 *   success: {"ok":1,"id":7}
 *   failure: {"e":1} (or {"e":"reason"} where the reason matters)
 */
export async function registerActivityRoutes(fastify: FastifyInstance) {
  fastify.post<{
    Body: { farmer_id?: string; type?: string; date?: string };
  }>('/activities', async (request, reply) => {
    const { farmer_id, type, date } = request.body ?? {};

    if (!farmer_id || typeof farmer_id !== 'string') {
      return reply.code(400).send({ e: 'farmer_id required' });
    }
    if (!type || !isAllowedActivityType(type)) {
      return reply.code(400).send({ e: 1 });
    }
    const parsedDate = new Date(date ?? '');
    if (!date || Number.isNaN(parsedDate.getTime())) {
      return reply.code(400).send({ e: 'invalid date' });
    }

    const { id } = logActivity(farmer_id, type, date);
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
        activities: activities.map((a) => ({ t: a.type, ts: a.timestamp })),
      });
    }
  );
}
