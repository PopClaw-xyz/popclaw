/**
 * The one line shared by both scheduled features (the daily paper / dreaming):
 * **what to do when the agent has no cron tool at hand**.
 *
 * On real hardware, 2026-07-30/31 (#338): the owner's host config was an **exclusive**
 * `tools.allow` allowlist that listed only popclaw's tools — so OpenClaw's built-in
 * cron got silently dropped. The agent correctly refused to hand-edit the system
 * crontab (that instinct was right, and is preserved), but then wrote the task up as
 * feedback and mailed it to the vendor, and just sat there waiting for a reply.
 *
 * What's missing isn't a product feature, it's **a one-time grant on this machine**,
 * and whoever can give that grant is sitting in the very same conversation. So this
 * one line does exactly one thing: name the missing tool, state plainly that only the
 * owner can grant it, call out the exclusive allowlist as the root cause, and block
 * off both wrong paths. popclaw **never edits the owner's host config for them**, and
 * doesn't couple to host internals either — it just hands the owner a line they can
 * act on directly.
 */
export const CRON_GRANT_ADVICE =
  'If you have no cron tool available, do not hand-edit the system crontab and do not mail this task to anyone — ' +
  'tell the owner to add `cron` to `tools.allow` in their OpenClaw config (an exclusive allowlist silently drops host-native tools, which is why it is missing); ' +
  'only the owner can grant it, popclaw never changes their config for them.';
