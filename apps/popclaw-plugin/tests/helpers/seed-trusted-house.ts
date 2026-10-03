/**
 * Make a seeded data root look like a machine that has already mounted a
 * MODERN house: a verified binding it trusts, and the declaration that binding
 * arrived with, saying that house verifies identity read credentials.
 *
 * Both halves are needed and neither substitutes for the other. Without the
 * pin there is no audience to sign for; without the declaration there is no
 * scheme to sign under, and either way every identity-bearing read refuses —
 * which is correct, and which would turn an out-of-process integration test
 * into a silent "the inbox never opened".
 *
 * The declaration used to be seeded into the handshake cache under
 * `data/lorehouses/`, because that is where the resolver read it from. It now
 * lives where a verified login puts it — a row in the host database, filed
 * under the pin's own key — so it is seeded through the production projector,
 * over the bytes of a manifest, rather than by hand-writing a JSON field.
 *
 * Written before the server starts, into the database the server will open
 * (migrated here, with the same migrations the boot runs). A house that then
 * serves no manifest leaves it untouched, which is exactly what a stub house
 * does.
 */
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { LocalHostDb } from '../../src/host/local-host-db.js';
import { runMigrations } from '../../src/host/migrations.js';
import { establishTrust } from '../../src/world/house-binding-pin.js';
import { projectReadDeclarationInTx } from '../../src/world/house-read-declaration.js';
import { PopclawPaths } from '../../src/host/popclaw-paths.js';
import { READ_CREDENTIAL_SCHEME } from '../../src/identity/read-credential.js';

const MIGRATIONS = resolve(dirname(fileURLToPath(import.meta.url)), '../../migrations');

/** The house key these fixtures pin. Whoever verifies a token rebuilds with it. */
export const SEEDED_HOUSE_KEY = '9xQeWy8P3vNhKd2RmTzA6BcFgJ4LnSuVoXpYrEt5Hw1Z';

export function seedTrustedHouse(root: string, houseUrl: string): void {
  const paths = new PopclawPaths(root);
  const dbFile = paths.socialDb();
  mkdirSync(dirname(dbFile), { recursive: true });
  const db = new LocalHostDb(dbFile);
  try {
    runMigrations(db, MIGRATIONS);
    establishTrust(
      db,
      { origin: houseUrl, houseKey: SEEDED_HOUSE_KEY, incarnation: 'inc-1' },
      'configured',
      () => 1_700_000_000,
    );
    // The same projector the commit runs, over the bytes of a manifest this
    // house could have served. Writing the row by hand would seed a shape the
    // production path can no longer produce.
    db.transaction((tx) =>
      projectReadDeclarationInTx(
        tx,
        { origin: houseUrl, houseKey: SEEDED_HOUSE_KEY },
        new TextEncoder().encode(
          JSON.stringify({
            house: { name: 'test house' },
            official_ids: [],
            read_auth: { schemes: [READ_CREDENTIAL_SCHEME] },
          }),
        ),
        1_700_000_000,
      ),
    );
  } finally {
    db.close();
  }
}
