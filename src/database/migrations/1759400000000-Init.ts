import { MigrationInterface, QueryRunner } from 'typeorm';

const TENANT_TABLES = [
  'tenant_settings',
  'users',
  'groups',
  'zones',
  'group_zones',
  'zone_agent_access',
  'zone_requests',
  'work_days',
  'day_pauses',
  'positions',
  'mission_types',
  'missions',
  'mission_submissions',
  'notifications',
  'refresh_tokens',
  'audit_logs',
];

// app.tenant_id est positionné au début de chaque transaction par l'API.
// app.bypass_rls est réservé aux traitements système (connexion, tâches planifiées).
const POLICY = (column: string) => `
  current_setting('app.bypass_rls', true) = 'on'
  OR ${column} = nullif(current_setting('app.tenant_id', true), '')::uuid`;

export class Init1759400000000 implements MigrationInterface {
  name = 'Init1759400000000';

  public async up(q: QueryRunner): Promise<void> {
    const appUser = process.env.DATABASE_APP_USER ?? 'suivi_app';

    await q.query(`CREATE EXTENSION IF NOT EXISTS postgis`);

    await q.query(`
      CREATE TABLE tenants (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        name text NOT NULL,
        created_at timestamptz NOT NULL DEFAULT now()
      )`);

    await q.query(`
      CREATE TABLE tenant_settings (
        tenant_id uuid PRIMARY KEY REFERENCES tenants(id) ON DELETE CASCADE,
        use_groups boolean NOT NULL DEFAULT false,
        zone_access_without_groups text NOT NULL DEFAULT 'all',
        zone_required boolean NOT NULL DEFAULT true,
        approval_mode text NOT NULL DEFAULT 'automatic',
        mixed_criteria jsonb NOT NULL DEFAULT '{"sensitiveZone":true,"fillThresholdPercent":null,"zoneChange":false,"probationAgent":false}',
        request_expiration_minutes integer NOT NULL DEFAULT 30,
        expiration_action_manual text NOT NULL DEFAULT 'release_seat',
        expiration_action_mixed text NOT NULL DEFAULT 'auto_approve',
        allow_zone_change_before_start boolean NOT NULL DEFAULT true,
        start_while_pending boolean NOT NULL DEFAULT false,
        daily_reset_time text NOT NULL DEFAULT '00:00',
        timezone text NOT NULL DEFAULT 'Africa/Abidjan',
        track_during_pause boolean NOT NULL DEFAULT false,
        auto_end_day_at_reset boolean NOT NULL DEFAULT true,
        signal_lost_minutes integer NOT NULL DEFAULT 10,
        position_retention_days integer NOT NULL DEFAULT 365,
        last_reset_date date,
        updated_at timestamptz NOT NULL DEFAULT now()
      )`);

    await q.query(`
      CREATE TABLE users (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
        email text NOT NULL,
        password_hash text NOT NULL,
        first_name text NOT NULL,
        last_name text NOT NULL,
        phone text,
        role text NOT NULL,
        group_id uuid,
        on_probation boolean NOT NULL DEFAULT false,
        is_active boolean NOT NULL DEFAULT true,
        created_at timestamptz NOT NULL DEFAULT now()
      )`);
    await q.query(
      `CREATE UNIQUE INDEX users_email_key ON users (lower(email))`,
    );
    await q.query(`CREATE INDEX users_tenant_idx ON users (tenant_id, role)`);

    await q.query(`
      CREATE TABLE groups (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
        name text NOT NULL,
        leader_id uuid REFERENCES users(id) ON DELETE SET NULL,
        created_at timestamptz NOT NULL DEFAULT now()
      )`);
    await q.query(
      `ALTER TABLE users ADD CONSTRAINT users_group_fk FOREIGN KEY (group_id) REFERENCES groups(id) ON DELETE SET NULL`,
    );

    await q.query(`
      CREATE TABLE zones (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
        name text NOT NULL,
        area geometry(Polygon, 4326) NOT NULL,
        capacity integer CHECK (capacity IS NULL OR capacity > 0),
        sensitive boolean NOT NULL DEFAULT false,
        restricted boolean NOT NULL DEFAULT false,
        is_active boolean NOT NULL DEFAULT true,
        created_at timestamptz NOT NULL DEFAULT now()
      )`);
    await q.query(`CREATE INDEX zones_area_idx ON zones USING gist (area)`);

    await q.query(`
      CREATE TABLE group_zones (
        group_id uuid NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
        zone_id uuid NOT NULL REFERENCES zones(id) ON DELETE CASCADE,
        tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
        PRIMARY KEY (group_id, zone_id)
      )`);

    await q.query(`
      CREATE TABLE zone_agent_access (
        zone_id uuid NOT NULL REFERENCES zones(id) ON DELETE CASCADE,
        agent_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
        PRIMARY KEY (zone_id, agent_id)
      )`);

    // Une demande « pending » réserve une place, une demande « approved » l'occupe.
    await q.query(`
      CREATE TABLE zone_requests (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
        agent_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        zone_id uuid NOT NULL REFERENCES zones(id) ON DELETE CASCADE,
        status text NOT NULL,
        is_change boolean NOT NULL DEFAULT false,
        requires_approval boolean NOT NULL DEFAULT false,
        work_date date NOT NULL,
        expires_at timestamptz,
        reminder_sent_at timestamptz,
        decided_by_id uuid REFERENCES users(id) ON DELETE SET NULL,
        decided_at timestamptz,
        decision_reason text,
        released_at timestamptz,
        release_reason text,
        created_at timestamptz NOT NULL DEFAULT now()
      )`);
    await q.query(
      `CREATE UNIQUE INDEX zone_requests_one_approved ON zone_requests (agent_id) WHERE status = 'approved'`,
    );
    await q.query(
      `CREATE UNIQUE INDEX zone_requests_one_pending ON zone_requests (agent_id) WHERE status = 'pending'`,
    );
    await q.query(
      `CREATE INDEX zone_requests_seats_idx ON zone_requests (zone_id) WHERE status IN ('pending', 'approved')`,
    );
    await q.query(
      `CREATE INDEX zone_requests_expiry_idx ON zone_requests (expires_at) WHERE status = 'pending'`,
    );

    await q.query(`
      CREATE TABLE work_days (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
        agent_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        zone_id uuid REFERENCES zones(id) ON DELETE SET NULL,
        status text NOT NULL,
        work_date date NOT NULL,
        started_at timestamptz NOT NULL DEFAULT now(),
        ended_at timestamptz,
        end_reason text,
        created_at timestamptz NOT NULL DEFAULT now()
      )`);
    await q.query(
      `CREATE UNIQUE INDEX work_days_one_open ON work_days (agent_id) WHERE status IN ('active', 'paused')`,
    );
    await q.query(
      `CREATE INDEX work_days_history_idx ON work_days (tenant_id, work_date)`,
    );

    await q.query(`
      CREATE TABLE day_pauses (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
        day_id uuid NOT NULL REFERENCES work_days(id) ON DELETE CASCADE,
        started_at timestamptz NOT NULL DEFAULT now(),
        ended_at timestamptz
      )`);
    await q.query(`CREATE INDEX day_pauses_day_idx ON day_pauses (day_id)`);

    await q.query(`
      CREATE TABLE positions (
        id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
        tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
        agent_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        day_id uuid NOT NULL REFERENCES work_days(id) ON DELETE CASCADE,
        lat double precision NOT NULL,
        lng double precision NOT NULL,
        location geometry(Point, 4326) NOT NULL,
        accuracy real NOT NULL,
        speed real,
        battery_level real,
        is_mocked boolean NOT NULL DEFAULT false,
        outside_zone boolean,
        recorded_at timestamptz NOT NULL,
        received_at timestamptz NOT NULL DEFAULT now()
      )`);
    // Idempotence de la synchronisation hors ligne : un même point renvoyé est ignoré.
    await q.query(
      `CREATE UNIQUE INDEX positions_dedup ON positions (agent_id, recorded_at)`,
    );
    await q.query(
      `CREATE INDEX positions_day_idx ON positions (day_id, recorded_at)`,
    );
    await q.query(
      `CREATE INDEX positions_retention_idx ON positions (tenant_id, recorded_at)`,
    );

    await q.query(`
      CREATE TABLE mission_types (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
        name text NOT NULL,
        description text,
        fields jsonb NOT NULL DEFAULT '[]',
        is_active boolean NOT NULL DEFAULT true,
        created_at timestamptz NOT NULL DEFAULT now()
      )`);

    await q.query(`
      CREATE TABLE missions (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
        type_id uuid NOT NULL REFERENCES mission_types(id) ON DELETE RESTRICT,
        title text NOT NULL,
        description text,
        assignee_agent_id uuid REFERENCES users(id) ON DELETE CASCADE,
        assignee_group_id uuid REFERENCES groups(id) ON DELETE CASCADE,
        progress_method text NOT NULL,
        target_value numeric NOT NULL CHECK (target_value > 0),
        sum_field_key text,
        due_date timestamptz,
        status text NOT NULL DEFAULT 'todo',
        created_by_id uuid REFERENCES users(id) ON DELETE SET NULL,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now(),
        CHECK ((assignee_agent_id IS NULL) <> (assignee_group_id IS NULL))
      )`);

    await q.query(`
      CREATE TABLE mission_submissions (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
        mission_id uuid NOT NULL REFERENCES missions(id) ON DELETE CASCADE,
        agent_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        day_id uuid REFERENCES work_days(id) ON DELETE SET NULL,
        client_id uuid NOT NULL,
        data jsonb NOT NULL,
        lat double precision,
        lng double precision,
        submitted_at timestamptz NOT NULL,
        received_at timestamptz NOT NULL DEFAULT now(),
        status text NOT NULL DEFAULT 'accepted',
        rejected_reason text,
        rejected_by_id uuid REFERENCES users(id) ON DELETE SET NULL
      )`);
    await q.query(
      `CREATE UNIQUE INDEX mission_submissions_dedup ON mission_submissions (agent_id, client_id)`,
    );
    await q.query(
      `CREATE INDEX mission_submissions_mission_idx ON mission_submissions (mission_id)`,
    );

    await q.query(`
      CREATE TABLE notifications (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
        user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        type text NOT NULL,
        title text NOT NULL,
        body text,
        data jsonb NOT NULL DEFAULT '{}',
        read_at timestamptz,
        created_at timestamptz NOT NULL DEFAULT now()
      )`);
    await q.query(
      `CREATE INDEX notifications_user_idx ON notifications (user_id, created_at DESC)`,
    );

    await q.query(`
      CREATE TABLE refresh_tokens (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
        user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        token_hash text NOT NULL UNIQUE,
        expires_at timestamptz NOT NULL,
        revoked_at timestamptz,
        created_at timestamptz NOT NULL DEFAULT now()
      )`);

    await q.query(`
      CREATE TABLE audit_logs (
        id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
        tenant_id uuid REFERENCES tenants(id) ON DELETE CASCADE,
        user_id uuid REFERENCES users(id) ON DELETE SET NULL,
        action text NOT NULL,
        method text,
        path text,
        status_code integer,
        ip text,
        created_at timestamptz NOT NULL DEFAULT now()
      )`);
    await q.query(
      `CREATE INDEX audit_logs_tenant_idx ON audit_logs (tenant_id, created_at DESC)`,
    );

    // Row Level Security
    await q.query(`ALTER TABLE tenants ENABLE ROW LEVEL SECURITY`);
    await q.query(`ALTER TABLE tenants FORCE ROW LEVEL SECURITY`);
    await q.query(
      `CREATE POLICY tenant_isolation ON tenants USING (${POLICY('id')}) WITH CHECK (${POLICY('id')})`,
    );
    for (const table of TENANT_TABLES) {
      await q.query(`ALTER TABLE ${table} ENABLE ROW LEVEL SECURITY`);
      await q.query(`ALTER TABLE ${table} FORCE ROW LEVEL SECURITY`);
      await q.query(
        `CREATE POLICY tenant_isolation ON ${table} USING (${POLICY('tenant_id')}) WITH CHECK (${POLICY('tenant_id')})`,
      );
    }

    await q.query(`GRANT USAGE ON SCHEMA public TO ${appUser}`);
    await q.query(
      `GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO ${appUser}`,
    );
    await q.query(
      `GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO ${appUser}`,
    );
  }

  public async down(q: QueryRunner): Promise<void> {
    for (const table of [...TENANT_TABLES].reverse()) {
      await q.query(`DROP TABLE IF EXISTS ${table} CASCADE`);
    }
    await q.query(`DROP TABLE IF EXISTS tenants CASCADE`);
  }
}
