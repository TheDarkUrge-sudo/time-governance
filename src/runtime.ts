/** Builds the live dependencies for a job run from the environment. */
import { connect } from './db/client';
import { Store } from './db/store';
import type { Roster } from './domain';
import { emailConfigured, sendgridTransport } from './email/sendgrid';
import { env } from './env';
import type { JobDeps } from './jobs/context';
import { KarbonClient } from './karbon/client';
import { resolveInternalClients } from './karbon/internal-client';
import { policyFromEnv } from './policy';

export interface Runtime {
  deps: JobDeps;
  close: () => Promise<void>;
}

export async function liveRuntime(opts: {
  dryRun: boolean;
  outDir: string | null;
  /** Dry runs may read the roster from a workbook instead of the database. */
  roster?: Roster;
}): Promise<Runtime> {
  const karbon = new KarbonClient();
  let store: Store | null = null;
  let close = () => Promise.resolve();
  if (!opts.dryRun || !opts.roster) {
    const conn = connect();
    store = new Store(conn.db);
    close = conn.close;
  }
  const roster = opts.roster ?? (await store!.loadRoster());
  const sendable = !opts.dryRun && env.TG_MODE !== 'off';
  if (sendable && env.TG_MODE === 'shadow' && !env.TG_SHADOW_TO) {
    throw new Error('TG_MODE is "shadow" but TG_SHADOW_TO is not set — nowhere to send.');
  }
  if (sendable && !emailConfigured()) {
    throw new Error(
      `TG_MODE is "${env.TG_MODE}" but email is not configured (SENDGRID_API_KEY, SENDGRID_FROM_EMAIL).`,
    );
  }
  const internal = await resolveInternalClients(
    karbon,
    env.KARBON_INTERNAL_CLIENT_IDS,
    env.KARBON_INTERNAL_CLIENT_KEYS,
  );
  return {
    deps: {
      karbon,
      store: opts.dryRun ? null : store,
      roster,
      policy: policyFromEnv(),
      delivery: {
        mode: env.TG_MODE,
        shadowTo: env.TG_SHADOW_TO ?? null,
        store: opts.dryRun ? null : store,
        transport: sendable ? sendgridTransport() : null,
        dryRun: opts.dryRun,
        outDir: opts.outDir,
      },
      adminTo: env.TG_ADMIN_TO,
      internalClientKeys: internal.keys,
      adHocTitle: env.KARBON_AD_HOC_TITLE,
      retentionDays: env.HISTORY_RETENTION_DAYS,
      setupNotes: internal.notes,
    },
    close,
  };
}
