import 'dotenv/config';
import { DataSource } from 'typeorm';

/** Source de données des migrations : propriétaire des tables (pas le rôle applicatif). */
export default new DataSource({
  type: 'postgres',
  host: process.env.DATABASE_HOST,
  port: Number(process.env.DATABASE_PORT),
  username: process.env.DATABASE_USER,
  password: process.env.DATABASE_PASSWORD,
  database: process.env.DATABASE_NAME,
  migrations: [__dirname + '/migrations/*.{ts,js}'],
});
