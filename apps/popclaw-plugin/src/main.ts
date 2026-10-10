import { localParticipationPort } from './host/local-participation.js';
import { hostDbSlug } from './ingress/host-slug.js';
import { makeRelationProducer } from './social-graph/relation-assembly.js';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { realpathSync } from 'node:fs';
import { assertStorageBootstrap, registerStorageRuntime } from './host/storage-maintenance.js';
import { ExecutionStoreCatalog } from './host/execution-store.js';
import { WorldRuntime } from './runtime/world-runtime.js';
import { readHouseCapabilityView } from './world/world-capabilities.js';
import { WORLD_COMMAND_HELP } from './commands/popclaw-world.js';
import { parseWorldCliArgs, runWorldCliCommand } from './commands/world-cli.js';
import { makeDmNotificationPolicy } from './runtime/dm-notification-policy.js';
import { SqliteNotifier } from './notifier/sqlite-notifier.js';
import { VerifiedFollowersCache } from './identity/verified-followers-cache.js';
import { personVerdict } from './butler/person-verdict.js';
import { readHouseHandshake, refreshHouseHandshake, houseDisplayName } from './world/house-handshake.js';
import { houseReadAuthority } from './identity/read-authority.js';
import { CadenceLoader, defaultCadence } from './cadence/cadence-loader.js';
import { makeBondContext } from './bonds/bond-context.js';
import type pino from 'pino';
import { LocalHostAdapter } from './host/local-host-adapter.js';
import { PopclawPaths } from './host/popclaw-paths.js';
import { pinoHostLogger } from './runtime/logger.js';
import { unsupportedNodeReason } from './runtime/node-support.js';
import { ServerPushEgress } from './egress/server-push-egress.js';
import { Ranger } from './runtime/ranger.js';
import { EventBuilder } from './event/event-builder.js';
import { InviteInitiator } from './invite/invite-initiator.js';
import { runInviteCommand } from './commands/invite.js';
import { runFollowCommand } from './commands/follow.js';
import { runStatusCommand } from './commands/status.js';
import { SocialGraph } from './social-graph/social-graph.js';
import { BondsStore } from './bonds/bonds-store.js';
import { SocialLogWriter } from './social-log/social-log.js';
import { bootstrapPlugin, extendBoot, type BootstrappedPlugin } from './runtime/plugin-bootstrap.js';
import { startDefaultHousePinning } from './social-graph/default-house-pinning.js';
import { KnownFollowersStore } from './social-graph/followers-sync.js';
import { createFollowerSync } from './social-graph/follower-sync-service.js';
import { startFollowDoorbell } from './newspaper/follow-doorbell-service.js';
import { startPageStateSync } from './canvas/sync-answer-client.js';
import { notifierForOrigin } from './runtime/house-lifecycle/notification-scope.js';
import { parseCliArgs, type CliArgs } from './cli-args.js';
import { setupCli } from './setup/cli.js';
import { HouseRuntime } from './runtime/house-lifecycle/house-runtime.js';
import { actionSigner } from './runtime/house-lifecycle/action-context.js';
import { openHouseStores, openWorldFeedStore } from './ingress/world-feed-store.js';
import {
  runHouseRecoveryCommand, runHouseLoginCommand,
  runHouseLogoutCommand,
} from './commands/popclaw-house.js';
import { InboxStore } from './messaging/inbox-store.js';
import { makeInboxOnMessage } from './runtime/inbox-consumer.js';
import { extractPostId } from './quest/verify-invite-handler.js';
import { canonicalPlatform } from './scraper/platform-scraper.js';
import { inviteAccountError, normalizeInviteHandle } from './invite/prepare-invite-share.js';
import { renderCopy } from './lexicon/index.js';
import { ownerLang } from './lexicon/owner-language.js';

// Test hook — do not call from production code paths.
export const parseArgsForTest = parseCliArgs;

type CliBoot = BootstrappedPlugin & { logger: ReturnType<typeof pinoHostLogger>; executionStores: ExecutionStoreCatalog; releaseStorage(): void };

/**
 * The dev CLI's single on-disk root. Base is `./.data` (NOT homedir — the CLI is
 * meant to run from a project dir), funneled through PopclawPaths.resolveRoot so
 * POPCLAW_DATA_ROOT overrides it and the host adapter + every consumer share one tree.
 */
function cliRoot(): string {
  return PopclawPaths.resolveRoot(process.env, './.data');
}
function cliPaths(): PopclawPaths {
  return new PopclawPaths(cliRoot());
}

async function bootstrap(machineOutput = false): Promise<CliBoot> {
  const logger = pinoHostLogger((process.env.LOG_LEVEL as pino.Level) ?? 'info', machineOutput ? process.stderr : undefined);
  // The same check index.ts makes at plugin load, made here too, because this
  // entry point is the OTHER way the plugin runs — the house ranger, in a
  // container someone else builds. Until 2026-09-19 it was the only member of
  // the fleet that never said which Node it was on, which is exactly how it
  // came to be running outside the supported range without anyone noticing.
  // Warn, never block: same reasoning as index.ts — it is already installed.
  const nodeIssue = unsupportedNodeReason();
  if (nodeIssue) {
    logger.warn(
      { node: process.version },
      `popclaw: ⚠️ ${nodeIssue} Upgrade Node — below the floor, dates and native modules go wrong quietly.`,
    );
  }
  const paths = cliPaths();
  assertStorageBootstrap(paths);
  let releaseStorage!: () => void;
  const host = new LocalHostAdapter({ dataRoot: cliRoot(), logger,
    beforeDbInitialize: db => (releaseStorage = registerStorageRuntime(db, paths)) });
  try {
    const boot = await bootstrapPlugin(host, './.data');
    return extendBoot(boot, { signer: actionSigner(boot.signer), logger, releaseStorage, executionStores: new ExecutionStoreCatalog({db: host.db, paths, actorId: boot.popclawId}) });
  } catch (error) { releaseStorage(); host.db.close(); throw error; }
}

/**
 * Build (and start) a SocialGraph backed by the social DB `follow_events`
 * table (boot.host.db). Used by the dev CLI's `follow` and `status`
 * subcommands. All signed writes go through the shared lifecycle owner.
 */
async function buildCliSocialGraph(
  boot: Awaited<ReturnType<typeof bootstrap>>,
  houses: HouseRuntime,
): Promise<SocialGraph> {
  const graph = new SocialGraph({
    db: boot.host.db,
    signer: boot.signer,
    // Same factory as the gateway and the MCP bridge. The CLI holds no
    // world-feed cache, so it names no discovery house and a new follow goes
    // to the home house — the answer the resolver gives anyway when nobody
    // has been seen anywhere.
    relationProducer: makeRelationProducer({
      db: boot.host.db,
      signer: boot.signer,
      houses: boot.loreHouseUrls.map((u) => ({ slug: hostDbSlug(u), origin: u })),
      pushTo: (slug, bytes) => houses.egress.pushTo(slug, bytes),
      logger: { info: (m) => boot.logger.info({}, m), warn: (m) => boot.logger.warn({}, m) },
    }),
    egressPush: async (bytes, houseSlug) => {
      await houses.egress.pushTo(houseSlug, bytes);
    },
    logger: {
      info: (m) => boot.logger.info({}, m),
      warn: (m) => boot.logger.warn({}, m),
      error: (m) => boot.logger.error({}, m),
    },
  });
  await graph.start();
  return graph;
}

async function runDaemonMode(
  boot: Awaited<ReturnType<typeof bootstrap>>,
): Promise<void> {
  const { host, signer, loreHouseUrl, logger, config, nickname, popclawId } = boot;
  // Same distinction the plugin gateway makes (index.ts): a freshly minted
  // identity must never look like a normal restore in the boot log.
  if (boot.identityGenerated) {
    // info on every root, so the four places that announce this all behave the same (see keystore.ts).
    logger.info(
      { popclaw_id: await signer.popclawId() },
      '★★★ NEW IDENTITY CREATED — no master.key existed; expected ONLY on first run. ' +
        'Otherwise check POPCLAW_DATA_ROOT: the old identity cannot be recovered or revoked.',
    );
  } else {
    logger.info({ popclaw_id: await signer.popclawId() }, 'identity loaded (restored existing key)');
  }

  // Named once: the house runtime and the follower poll must prove who is
  // asking the same way, or the poll silently asks a different question.
  const readAuthorityFor = (origin: string) => houseReadAuthority(
    { db: host.db, signer },
    origin,
  );
  const houses = new HouseRuntime({ db: host.db, signer, actorId:boot.popclawId, participation:localParticipationPort(() => undefined), origins: boot.loreHouseUrls,
    readAuthorityFor,
    publicV1Mode: process.env['POPCLAW_WORLD_STREAM'] === 'public-v1', executionStores: boot.executionStores,
    log: message => logger.warn({}, message) });

  const paths = cliPaths();
  const inboxStore = new InboxStore(host.db);
  // Social log (the raw-material warehouse for the night digest, ADR-0023
  // Revision 2026-07-26). All three composition roots have to record it: which
  // host the owner happened to receive the letter in has nothing to do with
  // whether it belongs in the digest.
  const bondsStore = new BondsStore(host.db);
  const socialLog = new SocialLogWriter({
    dir: paths.socialLogDir(),
    warn: (m) => logger.warn({}, `popclaw: ${m}`),
    bondTierOf: (id) => bondsStore.get(id)?.tier ?? null,
  });
  // Spec B slice 4: isomorphic to the plugin side — `lore_houses` is one DM
  // stream per house; cross-house dedup still relies on `wasNew` (the dedup
  // key is house-independent → exactly-once is unaffected by multi-house).
  const dmGraph = await buildCliSocialGraph(boot, houses);
  const dmFollowers = new VerifiedFollowersCache({ loreHouseUrl: boot.loreHouseUrl, fetch: houses.fetchHouse });
  const dmCadence = await new CadenceLoader({ cadenceDir: paths.cadenceDir(), logger: { warn: (m) => logger.warn({}, m) } }).load().catch(() => null);
  const notifier = new SqliteNotifier(host.db);
  const dmPolicy = makeDmNotificationPolicy({
    gateForHouse: slug => houses.gateForSlug(slug),
    inbox: inboxStore, notifier, graph: dmGraph,
    verdictOf: (id, slug) => personVerdict(id, { bondOf: (who) => bondsStore.get(who), verifiedFollowersOf: (who) => dmFollowers.getFresh(who, slug ? houses.originForSlug(slug) : undefined) }),
    isOfficial: (id, slug) => houses.gateForSlug(slug).isActive() && (readHouseHandshake(paths, slug)?.official_ids.includes(id) ?? false),
    vipThreshold: dmCadence?.notifications.vipExternalFollowerThreshold ?? defaultCadence().notifications.vipExternalFollowerThreshold,
    refresh: (id, slug) => dmFollowers.refresh(id, slug ? houses.originForSlug(slug) : undefined), nameOf: (id, nickname) => nickname || id,
    bondContext: makeBondContext({ bond: (id) => bondsStore.get(id), lastIncomingTs: (id, ts) => inboxStore.lastIncomingTs(id, ts) }),
    warn: (m) => logger.warn({}, m),
  });
  const onInbox = makeInboxOnMessage({
      onPlainDm: ({ item }) => dmPolicy.handle(item),
      signer,
      inboxStore,
      socialLog,
      dmMediaDir: () => paths.dmMediaDir(),
      // No mediaNaming: the daemon has always saved attachments under the
      // sigil-only name. See the knife's report — aligning it with the other
      // two roots renames files on disk, so it is a decision, not a refactor.
      info: (m) => logger.info({}, m),
      warn: (m) => logger.warn({}, m),
    });
  const houseStores = await openHouseStores(boot.loreHouseUrls, paths, {executionStores: boot.executionStores});
  // The CLI does not receive relations, and that is the right answer rather
  // than a gap. It is a short-lived process: it would open a personal stream,
  // claim whatever frames arrived during one command, and exit — leaving the
  // business work to a drain tick that never comes. The resident roots (the
  // gateway and the MCP host) receive; this one signs and sends.
  //
  // Nothing is lost by not claiming: an unclaimed frame is redelivered, and
  // the follower rows a resident root writes carry their own unannounced
  // debt, so whatever happens while no resident is running is picked up when
  // one next runs.
  houses.configureResources({ host, recipientPopclawId: popclawId,
    worldStreamMode: process.env['POPCLAW_WORLD_STREAM'] === '1', stores: houseStores,
    openStore: origin => openWorldFeedStore(origin, paths, undefined, boot.executionStores), onStore: store => { houseStores.push(store); },
    isOfficialActor: (house, id) => readHouseHandshake(paths, house.slug)?.official_ids.includes(id) ?? false,
    onInbox: (house, _gate, dm, bytes, nickname, authenticatedPlain) => onInbox(dm, house.slug, bytes, nickname, authenticatedPlain),
    createRanger: (house, gate, ingress) => new Ranger({host, config, signer, nickname,
      houseOrigin: house.baseUrl, gate, ingress, egress: new ServerPushEgress({baseUrl: house.baseUrl, gate})}),
    refresh: (house, gate) => refreshHouseHandshake(house.baseUrl, {paths, fetch: houses.houseFetch(house.baseUrl, gate),
      guideFetch: houses.documentFetch(house.baseUrl, gate)}),
    log: message => logger.warn({}, message),
  });
  houses.start();
  if (houses.storageAllows('consumers')) void houses.runCommand(() => dmPolicy.recover()).catch(err => host.logger.warn({}, `popclaw: DM recovery failed: ${String(err)}`));

  // The third resident root does the same as the other two: trust what the
  // config already names, once per boot, with the same bounded retry — and
  // behind the same storage gate, so a root held for recovery reaches for
  // nothing.
  const housePinning = houses.storageAllows('consumers')
    ? startDefaultHousePinning({
        db: host.db, recipientPopclawId: popclawId, origins: boot.loreHouseUrls,
        pinning: houses.configuredHousePinning, onParticipationChanged: () => houses.participationChanged(),
        warn: message => logger.warn({}, `popclaw: ${message}`),
      })
    : undefined;

  // And the same follower poll, for the same reason. This root receives no
  // relations (see above), so the poll is not a backstop here — it is the
  // ONLY way the owner is told that someone followed them while the daemon is
  // the process that is running, and it is the only writer of the baseline
  // the other roots' announcements join on.
  const followerSync = houses.storageAllows('consumers')
    ? createFollowerSync({
        db: host.db,
        deps: {
          ownerPopclawId: popclawId,
          store: new KnownFollowersStore(host.db),
          notifier,
          socialGraph: dmGraph,
          socialLog,
          bondOf: (id) => bondsStore.get(id),
          verifiedFollowers: dmFollowers,
          fetch: houses.fetchHouse,
          readAuthorityFor: (house) => readAuthorityFor(house.baseUrl),
          logger: { info: (m) => logger.info({}, m), warn: (m) => logger.warn({}, m) },
        },
        houses: () => [...new Set([...houseStores.map(h => h.baseUrl), ...houses.commands.knownHouseOrigins()])]
          .map(baseUrl => ({slug: hostDbSlug(baseUrl), baseUrl})),
        runCommand: (work) => houses.runCommand(work),
        captureGate: (origin) => houses.captureGate(origin),
        observeParticipation: changed => houses.observeParticipationChanges(changed),
      })
    : undefined;
  void followerSync?.start();

  // The follow doorbell, third of the legs every resident root owes. This root
  // publishes no papers of its own, which changes nothing: a ➕ is credited to
  // the READER who clicked it, so the owner's clicks on OTHER people's papers
  // are waiting at the canvas whichever process happens to be running. Nothing
  // but this pulls them, and an unpulled intent expires.
  //
  // No `deliverNow` and no display-name chain here: this root has neither, and
  // inventing one would be worse than the gap. Without a push channel the loop
  // never claims a batch (see `DoorbellDeps.deliverNow`) — it absorbs, records
  // and enqueues the L2 pointer, and a root that CAN read the names out still
  // finds the batch unsurfaced.
  const doorbell = houses.storageAllows('consumers')
    ? startFollowDoorbell({
        db: host.db,
        ownerPopclawId: popclawId,
        canvasBaseUrl: boot.canvasBaseUrl,
        signer,
        followsIn: (id) => dmGraph.follows(id),
        notifier: notifierForOrigin(notifier, loreHouseUrl),
        runCommand: (work) => houses.runCommand(work),
        captureGate: (origin) => houses.captureGate(origin),
        houseOrigin: loreHouseUrl,
        observeParticipation: changed => houses.observeParticipation(loreHouseUrl, changed),
        logger: { info: (m) => logger.info({}, m), warn: (m) => logger.warn({}, m) },
      })
    : undefined;

  // And the answer half: a paper published from any root on this data root has
  // chips that only ever colour if somebody answers the canvas.
  const pageState = houses.storageAllows('consumers')
    ? startPageStateSync({
        baseUrl: boot.canvasBaseUrl,
        signer,
        stateOf: (id) => (dmGraph.follows(id) ? 'follows' : 'none'),
        logger: { info: (m) => logger.info({}, m) },
      })
    : undefined;

  const shutdown = async (sig: string) => {
    logger.info({ signal: sig }, 'popclaw-plugin shutting down');
    housePinning?.stop();
    followerSync?.stop();
    doorbell?.stop();
    pageState?.stop();
    await houses.stop();
    for (const house of houseStores) house.db.close();
    boot.executionStores.close(); boot.releaseStorage();
    host.db.close();
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));

  logger.info({ lore_house: loreHouseUrl }, 'house lifecycle runtime started');
}

async function runInviteSubcommand(
  boot: Awaited<ReturnType<typeof bootstrap>>,
  args: CliArgs,
  houses: HouseRuntime,
): Promise<number> {
  // Canonicalize before signing: "X"/"Twitter" must not become distinct
  // platforms server-side (already-verified checks are keyed by platform).
  const platform = args.positional[0] ? canonicalPlatform(args.positional[0].trim()) : args.positional[0];
  const handle = args.positional[1] ? normalizeInviteHandle(args.positional[1]) : args.positional[1];
  if (!platform || !handle) {
    console.error('usage: popclaw invite <platform> <handle> [--nickname=X] [--proof=<post url>]');
    return 1;
  }
  // ADR-0034 preflight: this parser only supports --proof=<url>; a bare
  // `--proof <url>` lands as the literal 'true' and would be signed and
  // dispatched. Fail fast with instant feedback instead.
  if (args.flags['proof'] !== undefined && !extractPostId(args.flags['proof'])) {
    console.error(renderCopy(ownerLang(), 'invite.cli.badProofFlag', { got: args.flags['proof'] }));
    return 1;
  }
  const nickname = args.flags['nickname'] ?? boot.nickname;
  const pollTimeoutSec = args.flags['poll-timeout-sec']
    ? Number(args.flags['poll-timeout-sec'])
    : undefined;
  const pollIntervalMs = args.flags['poll-interval-ms']
    ? Number(args.flags['poll-interval-ms'])
    : undefined;

  const eventBuilder = new EventBuilder(boot.signer, nickname);
  const initiator = new InviteInitiator({ signer: boot.signer, eventBuilder, egress: houses.egress });

  const logLine = (msg: string) => boot.logger.info({}, msg);
  const result = await runInviteCommand(
    {
      initiator,
      signer: boot.signer,
      loreHouseUrl: boot.loreHouseUrl,
      fetch: houses.fetchHouse,
      logger: { info: logLine, warn: (msg: string) => boot.logger.warn({}, msg) },
    },
    // ADR-0034: --proof=<post url> → rangers verify by-id instead of by search.
    // `--sync` is the whole opt-in. Absent = no, which
    // is the answer verification has always implied and never asked for.
    {
      platform,
      handle,
      nickname,
      proofUrl: args.flags['proof'],
      mirrorOptin: args.flags['sync'] !== undefined && args.flags['sync'] !== 'false',
      pollTimeoutSec,
      pollIntervalMs,
    },
  );
  return result.verified ? 0 : 0; // don't exit-1 on timeout; status command can re-check
}

async function runFollowSubcommand(
  boot: Awaited<ReturnType<typeof bootstrap>>,
  args: CliArgs,
  houses: HouseRuntime,
): Promise<number> {
  const target = args.positional[0];
  if (!target) {
    console.error('usage: popclaw follow <target>  (target = popclaw_id; platform:handle pending Phase 2)');
    return 1;
  }
  const socialGraph = await buildCliSocialGraph(boot, houses);
  const paths = cliPaths();
  const result = await runFollowCommand(target, {
    socialGraph,
    ownPopclawId: boot.popclawId,
    houseDisplayName: (slug) => houseDisplayName(paths, boot.loreHouseUrls, slug),
  });
  console.log(result.text);
  return result.outcome.kind === 'accepted' ? 0 : 1;
}

async function runStatusSubcommand(
  boot: Awaited<ReturnType<typeof bootstrap>>,
  houses: HouseRuntime,
): Promise<number> {
  const socialGraph = await buildCliSocialGraph(boot, houses);
  await runStatusCommand({
    signer: boot.signer,
    host: boot.host,
    loreHouseUrl: boot.loreHouseUrl,
    // Public /v1/profile GET: the read lane, so a CLI beside a running gateway
    // is not refused by the owner lane and told the house is down (R17-D1).
    fetch: houses.houseReadFetch(boot.loreHouseUrl),
    socialGraph,
    nickname: boot.nickname,
    webBaseUrl: boot.webBaseUrl,
    configuredHouses: boot.loreHouseUrls,
  });
  return 0;
}
/** Exposed so a test can pin which house lane the CLI status reads through. */
export const runStatusSubcommandForTest = runStatusSubcommand;

/**
 * ADR-0051 S3 — `popclaw login <host>` / `popclaw logout <host>`. The CLI is a
 * ONE-SHOT process: it runs the shared coordinator implementation and exits;
 * the ENABLED state is carried by the persistent participation rows — the
 * resident coordinator in the daemon/hosts picks the change up from the same
 * data root. No daemon is started, no background promise is left dangling.
 */
async function runHouseSubcommand(
  args: CliArgs,
  houses: HouseRuntime,
  actorId: string,
): Promise<number> {
  const target = args.positional[0] ?? '';
  if (!target) {
    console.error(`usage: popclaw ${args.subcommand} <host>`);
    return 2;
  }
  let exitCode = 0;
  const ctx = { lang: ownerLang, recovery: houses.recovery, readHouseGuide: (origin:string) => houses.readHouseGuide(origin),
    readAgentContext: (origin: string, sessionId: string) => houses.readAgentContext(origin, actorId, {}, sessionId),
    coordinator: () => ({ ...houses.commands,
    loginHouse: async (origin: string) => {
      const result = await houses.commands.loginHouse(origin);
      exitCode = result.status === 'connected' || result.admission === 'configured' ? 0 : 1;
      return result;
    },
  }) };
  console.log(await (args.subcommand === 'recover' ? runHouseRecoveryCommand(ctx,target) : args.subcommand === 'login'
    ? runHouseLoginCommand(ctx, target) : runHouseLogoutCommand(ctx, target)));
  return exitCode;
}


function printUsage(sink: (line: string) => void): void {
  // Human wording lives in the lexicon (the CJK ratchet's rule); the command
  // spellings are constants. The owner's language lane is read WITHOUT any
  // bootstrap (owner-language.ts is a pure file read on the data root —
  // help/metadata must not mint identities or open DBs).
  const lang = ownerLang();
  sink(renderCopy(lang, 'cli.usage.line1', {}));
  sink(renderCopy(lang, 'cli.usage.daemon', {}));
  sink(renderCopy(lang, 'cli.usage.login', {}));
  sink(renderCopy(lang, 'cli.usage.logout', {}));
  sink(renderCopy(lang, 'help.recover.usage', {}));
  sink(renderCopy(lang, 'cli.usage.mcp', {}));
  sink(renderCopy(lang, 'cli.usage.more', {}));
  sink(WORLD_COMMAND_HELP);
}

async function main() {
  const argv = process.argv.slice(2);
  let args: CliArgs | {subcommand: 'world'; world: ReturnType<typeof parseWorldCliArgs>; positional: string[]; flags: Record<string, string>};
  try {
    args = argv[0] === 'world'
      ? {subcommand: 'world', world: parseWorldCliArgs(argv.slice(1)), positional: [], flags: {}}
      : parseCliArgs(argv);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    console.error(WORLD_COMMAND_HELP); process.exitCode = 2; return;
  }
  if (args.subcommand === 'world' && args.world.command === 'help') {
    console.log(WORLD_COMMAND_HELP); process.exitCode = 0; return;
  }

  // Cheap-metadata lane (review ①): unknown commands, help and
  // missing-target usage NEVER bootstrap — no identity, no DB, no network.
  // The daemon's "cheap metadata" promise (ADR-0035) extends to the CLI.
  if (args.subcommand === 'unknown') {
    if (args.unknownHead === '--help' || args.unknownHead === '-h' || args.unknownHead === 'help') {
      printUsage(console.log);
      process.exitCode = 0;
      return;
    }
    console.error(renderCopy(ownerLang(), 'cli.unknown', { head: JSON.stringify(args.unknownHead ?? '') }));
    printUsage(console.error);
    process.exitCode = 2;
    return;
  }
  if (Object.keys(args.flags).some((f) => f === 'help' || f === 'h')) {
    // `popclaw <sub> --help` — usage for that subcommand, exit 0, zero
    // bootstrap.
    printUsage(console.log);
    process.exitCode = 0;
    return;
  }
  if (args.subcommand === 'login' || args.subcommand === 'logout' || args.subcommand === 'recover') {
    const target = args.positional[0] ?? '';
    if (!target || (args.subcommand === 'recover' && (args.positional.length !== 1 || Object.keys(args.flags).length))) {
      console.error(`usage: popclaw ${args.subcommand} <host>`);
      process.exitCode = 2;
      return;
    }
  }

  if (args.subcommand === 'invite') {
    const [platform, handle] = args.positional;
    const error = !platform || !handle ? renderCopy(ownerLang(), 'invite.usage') : inviteAccountError(platform, handle);
    if (error) {
      console.error(error); process.exitCode = 2; return;
    }
  }

  const boot = await bootstrap(args.subcommand === 'world');

  if (args.subcommand === 'daemon') {
    boot.logger.info({ data_root: cliRoot(), subcommand: args.subcommand }, 'popclaw-plugin starting');
    await runDaemonMode(boot);
    return;
  }

  // Every one-shot shares one reader. It can queue signed bytes for the
  // existing resident, but never takes its lease or opens its streams.
  let houses: HouseRuntime | undefined;
  let worlds: WorldRuntime | undefined;
  const commandAbort = new AbortController();
  const commandHouseStores: import('./ingress/world-feed-store.js').HouseStore[] = [];
  let interrupted = false;
  const shutdown = (signal: 'SIGINT' | 'SIGTERM') => {
    interrupted = true;
    commandAbort.abort();
    worlds?.stop();
    process.exitCode = signal === 'SIGINT' ? 130 : 143;
    // stop() cancels waits and drains actual command work. Database handles
    // remain open until the normal finally below has awaited that same stop.
    void houses?.stop().catch(error => console.error('fatal', error));
  };
  const onInt = () => shutdown('SIGINT'), onTerm = () => shutdown('SIGTERM');
  process.on('SIGINT', onInt); process.on('SIGTERM', onTerm);
  try {
    // Publish the one-shot boot marker only after cancellation is installed.
    boot.logger.info({ data_root: cliRoot(), subcommand: args.subcommand }, 'popclaw-plugin starting');
    houses = new HouseRuntime({ db: boot.host.db, signer: boot.signer, actorId:boot.popclawId, participation:localParticipationPort(() => undefined), origins: boot.loreHouseUrls,
      readAuthorityFor: (origin: string) => houseReadAuthority(
        { db: boot.host.db, signer: boot.signer },
        origin,
      ),
      publicV1Mode: process.env['POPCLAW_WORLD_STREAM'] === 'public-v1', executionStores: boot.executionStores,
      log: message => boot.logger.warn({}, message) });
    if (args.subcommand === 'world') {
      const paths = cliPaths();
      houses.configureResources({host: boot.host, recipientPopclawId: boot.popclawId,
        worldStreamMode: false, stores: commandHouseStores,
        isOfficialActor: (house, id) => readHouseHandshake(paths, house.slug)?.official_ids.includes(id) ?? false,
        openStore: origin => openWorldFeedStore(origin, paths, undefined, boot.executionStores), onStore: house => { commandHouseStores.push(house); }});
      worlds = new WorldRuntime({mode: 'commands', houses, signer: boot.signer, actorId: boot.popclawId,
        readCapabilities: origin => readHouseCapabilityView(boot.host.db, origin)});
    }
    houses.startReader();
    const runtime = houses;
    const code = args.subcommand === 'login' || args.subcommand === 'logout' || args.subcommand === 'recover'
      ? await runHouseSubcommand(args, runtime, boot.popclawId)
      : await runtime.runCommand(async () => {
          switch (args.subcommand) {
            case 'world': {
              const result = await runWorldCliCommand(worlds!, args.world, {signal: commandAbort.signal});
              console.log(JSON.stringify(result)); return 0;
            }
            case 'invite': return runInviteSubcommand(boot, args, runtime);
            case 'follow': return runFollowSubcommand(boot, args, runtime);
            case 'status': return runStatusSubcommand(boot, runtime);
            default: throw new Error(`unhandled subcommand: ${args.subcommand}`);
          }
        });
    if (!interrupted) process.exitCode = code;
  } catch (error) {
    if (!interrupted) throw error;
  } finally {
    worlds?.stop();
    let joined = false;
    try { await houses?.stop(); await worlds?.whenIdle(); joined = true; }
    finally {
      for (const house of commandHouseStores) house.db.close();
      {
        boot.executionStores.close();
        if (joined) boot.releaseStorage();
        boot.host.db.close();
        process.removeListener('SIGINT', onInt); process.removeListener('SIGTERM', onTerm);
      }
    }
  }
}

/** Where the `popclaw` bin can send an invocation before any bootstrap runs. */
export interface CliEntryPorts {
  /** `popclaw setup …` — the first-install dispatcher (setup-core contract). */
  readonly runSetup: () => void;
  /** `popclaw mcp` — the stdio MCP composition root. */
  readonly startMcp: () => void;
  /** Everything else, unknown heads included: the ordinary CLI. */
  readonly runCli: () => void;
}

/**
 * Pre-bootstrap entry dispatch for the `popclaw` bin.
 *
 * `setup` and `mcp` are answered BEFORE the ordinary CLI: neither starts the
 * daemon, opens a house or mints a second identity on the way in, and no other
 * head may reach the MCP root — its import installs a process-wide stdout
 * guard. Every other head goes to `main()`, which keeps the fail-closed
 * usage/exit-2 path. The destinations are injected so the routing is testable
 * without starting any of them.
 */
export function dispatchCliEntry(argv: readonly string[], ports: CliEntryPorts): void {
  switch (argv[2]) {
    case 'setup':
      ports.runSetup();
      return;
    case 'mcp':
      ports.startMcp();
      return;
    default:
      ports.runCli();
      return;
  }
}

// Only auto-run when executed directly, not when imported by tests.
// argv[1] is canonicalized through realpath first: npm/pnpm bin entries are
// SYMLINKS into the package, and Node resolves the main module to its real
// path — a bare file:// comparison sees two different paths and the entry
// silently exits without running (reproduced with a real bin-style symlink;
// spaces in the package path are safe because both sides go through fileURLToPath).
const isDirectRun =
  typeof process !== 'undefined' &&
  Array.isArray(process.argv) &&
  process.argv[1] !== undefined &&
  import.meta.url === (() => {
    try {
      return new URL(`file://${realpathSync(process.argv[1]!)}`).href;
    } catch {
      return undefined;
    }
  })();

if (isDirectRun) {
  dispatchCliEntry(process.argv, {
    // First-install setup dispatcher (setup-core contract): `popclaw setup …`
    // is handled BEFORE any other CLI work — no daemon, no OpenClaw imports,
    // no house networking. The package root is this module's package: bundled
    // at <pkg>/dist/bundled/cli.js (two levels up) or run from <pkg>/src/main.ts.
    runSetup: () => {
      // Canonical absolute package root (setup-core contract). NOTE: from the
      // source checkout this resolves to apps/ — setup is NOT supported from a
      // source tree; the final extracted package layout (<pkg>/dist/bundled/
      // cli.js, two levels up from this module) is the accepted target.
      const packageRoot = realpathSync(resolve(dirname(fileURLToPath(import.meta.url)), '..', '..'));
      setupCli(process.argv.slice(3), packageRoot).then(
        (result) => {
          console.log(JSON.stringify(result, null, 2));
        },
        (err) => {
          console.error(String(err instanceof Error ? err.message : err));
          process.exitCode = 1;
        },
      );
    },
    // `src/mcp.ts` is import-to-run and takes over stdout as it loads, so it is
    // reached through a dynamic import: nothing of it is evaluated for any
    // other head. Failures are reported on stderr — fd 1 belongs to the
    // protocol from the moment that module starts loading.
    startMcp: () => {
      void import('./mcp.js').catch((err: unknown) => {
        process.stderr.write(`popclaw mcp fatal: ${String(err instanceof Error ? err.message : err)}\n`);
        process.exitCode = 1;
      });
    },
    runCli: () => {
      main().catch((err) => {
        console.error('fatal', err);
        process.exitCode = 1;
      });
    },
  });
}
