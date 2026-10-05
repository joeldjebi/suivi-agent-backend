/**
 * CTE `days` : une ligne par journée, avec le temps travaillé (secondes, pauses déduites).
 * Une journée non terminée s'arrête à la dernière position reçue (fin réelle d'activité).
 * `where` filtre `work_days d` (ex. sur d.work_date), avec les paramètres de l'appelant.
 */
export function workedDaysCte(where: string): string {
  return `bounds AS (
    SELECT d.id, d.agent_id, d.zone_id, d.work_date, d.end_reason, d.started_at,
           coalesce(d.ended_at,
                    (SELECT max(recorded_at) FROM positions WHERE day_id = d.id),
                    d.started_at) AS ended_at
    FROM work_days d
    WHERE ${where}
  ),
  days AS (
    SELECT b.id, b.agent_id, b.zone_id, b.work_date, b.end_reason, b.started_at,
           greatest(0,
             extract(epoch FROM b.ended_at - b.started_at)
             - coalesce((
                 SELECT sum(extract(epoch FROM
                          least(coalesce(p.ended_at, b.ended_at), b.ended_at) - p.started_at))
                 FROM day_pauses p WHERE p.day_id = b.id AND p.started_at < b.ended_at), 0)
           ) AS worked
    FROM bounds b
  )`;
}
