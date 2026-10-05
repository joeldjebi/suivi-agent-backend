// Les tests de bout en bout utilisent une base dédiée, jamais la base de développement.
process.env.DATABASE_NAME =
  process.env.TEST_DATABASE_NAME ?? 'suivi_agent_test';
process.env.JWT_SECRET ??= 'test-secret';
