-- Exécuté une seule fois à la création du volume.
-- L'API se connecte avec suivi_app (ni superutilisateur ni propriétaire des tables),
-- pour que la Row Level Security s'applique réellement.
CREATE ROLE suivi_app LOGIN PASSWORD 'suivi_app';
CREATE DATABASE suivi_agent_test OWNER suivi;
