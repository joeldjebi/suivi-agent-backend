// Les tests de bout en bout utilisent une base dédiée, jamais la base de développement.
process.env.DATABASE_NAME =
  process.env.TEST_DATABASE_NAME ?? 'suivi_agent_test';
process.env.JWT_SECRET ??= 'test-secret';
// Pas d'appel à OpenStreetMap pendant les tests : seules les communes du catalogue répondent.
process.env.GEOCODER = 'off';
