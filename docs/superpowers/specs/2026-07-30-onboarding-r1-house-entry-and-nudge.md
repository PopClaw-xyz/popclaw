# Onboarding nudge — prior specification clarification

The source specification dated 2026-07-30, section 4, said “one tail per turn.” For the approved 2026-10-05 tool-result notice feature this is replaced by the implementable sixty-second per-consumer cooldown described in [the notification specification](2026-10-05-notice-piggyback-design.md). Request IDs identify calls and session keys identify sessions; neither is a trusted turn ID.

The existing nudge eligibility, ledger, cooldown, exclusion and House guide behavior remain unchanged. A pending queued notification occupies the notice slot even if an automatic offer is rate limited. This snapshot did not contain the original internal specification; this file records only the relevant correction, not a reconstruction of its other sections.
