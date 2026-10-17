/**
 * Comptes super administrateur (éditeur), depuis le serveur.
 * Création (propriétaire s'il n'y en a pas encore) :
 *   npm run platform:admin -- email@editeur.ci 'MotDePasseLong' Prénom Nom
 * Désigner le compte propriétaire (accès perdu, passation) :
 *   npm run platform:admin -- --owner email@editeur.ci
 * En production (image compilée) : node dist/database/platform-admin.js …
 */
import * as bcrypt from 'bcrypt';
import 'dotenv/config';
import dataSource from './data-source';

async function setOwner(email: string) {
  await dataSource.transaction(async (m) => {
    const [target] = await m.query<{ id: string }[]>(
      `SELECT id FROM platform_admins WHERE lower(email) = lower($1)`,
      [email],
    );
    if (!target) throw new Error(`Aucun compte éditeur ${email}.`);
    await m.query(`UPDATE platform_admins SET is_owner = false WHERE is_owner`);
    await m.query(
      `UPDATE platform_admins SET is_owner = true, is_active = true WHERE id = $1`,
      [target.id],
    );
  });
  console.log(`Compte propriétaire : ${email.toLowerCase()}`);
}

async function create(
  email: string,
  password: string,
  firstName: string,
  lastName: string,
) {
  const [taken] = await dataSource.query<unknown[]>(
    `SELECT 1 FROM platform_admins WHERE lower(email) = lower($1)`,
    [email],
  );
  if (taken) {
    console.error(`Le compte ${email} existe déjà.`);
    process.exitCode = 1;
    return;
  }
  const [owner] = await dataSource.query<unknown[]>(
    `SELECT 1 FROM platform_admins WHERE is_owner`,
  );
  await dataSource.query(
    `INSERT INTO platform_admins (email, password_hash, first_name, last_name, is_owner)
     VALUES (lower($1), $2, $3, $4, $5)`,
    [email, await bcrypt.hash(password, 10), firstName, lastName, !owner],
  );
  console.log(
    `Compte éditeur créé : ${email.toLowerCase()}${owner ? '' : ' (propriétaire)'}`,
  );
}

async function main() {
  const args = process.argv.slice(2);
  if (args[0] === '--owner') {
    if (!args[1]) {
      console.error('Usage : npm run platform:admin -- --owner email');
      process.exitCode = 1;
      return;
    }
    await dataSource.initialize();
    return setOwner(args[1]);
  }
  const [email, password, firstName = 'Super', lastName = 'Admin'] = args;
  if (!email || !password || password.length < 10) {
    console.error(
      "Usage : npm run platform:admin -- email 'mot de passe (10 caractères minimum)' Prénom Nom",
    );
    process.exitCode = 1;
    return;
  }
  await dataSource.initialize();
  await create(email, password, firstName, lastName);
}

main()
  .catch((error: Error) => {
    console.error(error.message);
    process.exitCode = 1;
  })
  .finally(() => dataSource.isInitialized && dataSource.destroy());
