/**
 * Zones des missions qui n'en ont pas (démo) : celles du groupe assigné, sinon celles du
 * groupe de l'agent, sinon toutes les zones actives de la structure. Même ordre que la
 * migration MissionZones.
 */
export const MISSION_ZONES_BACKFILL = [
  `INSERT INTO mission_zones (mission_id, zone_id, tenant_id)
   SELECT m.id, gz.zone_id, m.tenant_id
   FROM missions m JOIN group_zones gz ON gz.group_id = m.assignee_group_id
   WHERE m.tenant_id = $1 AND NOT EXISTS (SELECT 1 FROM mission_zones mz WHERE mz.mission_id = m.id)
   ON CONFLICT DO NOTHING`,
  `INSERT INTO mission_zones (mission_id, zone_id, tenant_id)
   SELECT m.id, gz.zone_id, m.tenant_id
   FROM missions m JOIN users u ON u.id = m.assignee_agent_id
   JOIN group_zones gz ON gz.group_id = u.group_id
   WHERE m.tenant_id = $1 AND NOT EXISTS (SELECT 1 FROM mission_zones mz WHERE mz.mission_id = m.id)
   ON CONFLICT DO NOTHING`,
  `INSERT INTO mission_zones (mission_id, zone_id, tenant_id)
   SELECT m.id, z.id, m.tenant_id
   FROM missions m JOIN zones z ON z.tenant_id = m.tenant_id AND z.is_active
   WHERE m.tenant_id = $1 AND NOT EXISTS (SELECT 1 FROM mission_zones mz WHERE mz.mission_id = m.id)
   ON CONFLICT DO NOTHING`,
  // Zone de la journée des formulaires générés.
  `UPDATE mission_submissions s SET zone_id = d.zone_id
   FROM work_days d WHERE d.id = s.day_id AND s.tenant_id = $1 AND s.zone_id IS NULL`,
];
