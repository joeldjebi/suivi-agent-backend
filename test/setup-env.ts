import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Les tests de bout en bout utilisent une base dédiée, jamais la base de développement.
process.env.DATABASE_NAME =
  process.env.TEST_DATABASE_NAME ?? 'suivi_agent_test';
process.env.JWT_SECRET ??= 'test-secret';
// Pas d'appel à OpenStreetMap pendant les tests : seules les communes du catalogue répondent.
process.env.GEOCODER = 'off';
// Plafond de requêtes par IP désactivé : les tests enchaînent des centaines d'appels.
process.env.RATE_LIMIT ??= 'off';
// Photos du terrain : un dossier temporaire, jamais celui de développement.
process.env.STORAGE_DIR ??= join(tmpdir(), 'suivi-agent-test-storage');
// IA photo : modèle simulé, aucun appel réel pendant les tests.
process.env.PHOTO_AI_PROVIDER ??= 'fake';
