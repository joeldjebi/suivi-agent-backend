/**
 * Création d'un compte super administrateur (éditeur), par exemple à l'installation.
 * Usage : npm run platform:admin -- email@editeur.ci 'MotDePasseLong' Prénom Nom
 */
import * as bcrypt from 'bcrypt';
import 'dotenv/config';
import dataSource from './data-source';

async function main() {
  const [email, password, firstName = 'Super', lastName = 'Admin'] =
    process.argv.slice(2);
  if (!email || !password || password.length < 10) {
    console.error(
      "Usage : npm run platform:admin -- email 'mot de passe (10 caractères minimum)' Prénom Nom",
    );
    process.exitCode = 1;
    return;
  }
  await dataSource.initialize();
  const [taken] = await dataSource.query<unknown[]>(
    `SELECT 1 FROM platform_admins WHERE lower(email) = lower($1)`,
    [email],
  );
  if (taken) {
    console.error(`Le compte ${email} existe déjà.`);
    process.exitCode = 1;
    return;
  }
  await dataSource.query(
    `INSERT INTO platform_admins (email, password_hash, first_name, last_name)
     VALUES (lower($1), $2, $3, $4)`,
    [email, await bcrypt.hash(password, 10), firstName, lastName],
  );
  console.log(`Compte éditeur créé : ${email.toLowerCase()}`);
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => dataSource.isInitialized && dataSource.destroy());
