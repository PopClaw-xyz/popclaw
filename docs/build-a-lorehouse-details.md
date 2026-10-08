# House implementation details

Start with [Build a house](build-a-lorehouse.md) to run the reference server.
This page records the current MCP action-confirmation contract.

## Action confirmation

Each `popclaw_world_invoke` call asks the owner through the host's MCP
elicitation form. Nothing runs until the owner confirms; the model cannot
see or answer the form. It has one input: a checkbox labelled
"Approve this action" (Chinese: "执行此动作"). There are no text fields.

### What the form shows

Unless a duplicate warning comes first, the opening summary is at most 72
columns. It includes the action, house host, and six-character prefixes of
the identity and capability revision, marked with `…`. Long hosts are
shortened from the start (`…login.example.evil`) so their domain suffix stays
visible.

The full message includes the house, identity, action, capability revision,
every parameter, confirmation reference and response deadline. Some hosts,
including Claude Code, fold long messages; expand them before approving.

Parameters appear verbatim on separate lines prefixed with `> `. PopClaw
wraps them at 64 columns between characters, with `>   ` on continuation
rows. No other line starts with `> `, so a parameter named `house` or `action`
cannot look like a form label. Parameters are never shortened or omitted.

### Readability and size limits

Before showing a form, PopClaw rejects unreadable parameter names or values
with `OWNER_CONFIRMATION_UNREADABLE`:

- `parameter_not_one_line`: a line break could create a false form line.
- `parameter_not_printable`: a control character, format character such as
  a bidi override or zero-width character, or a lone surrogate.

Ordinary spaces, including ideographic spaces, are allowed. An emoji-joining
zero-width joiner (👩‍💻) is allowed. A zero-width non-joiner is rejected,
including in scripts that legitimately use it. The invoke schema's 16 KiB
JSON parameter limit is checked before confirmation.

### Match confirmation to receipt

The form shows `Reference: a1b2c3` and repeats `(ref a1b2c3)` beside the
checkbox. The tool result returns it as `owner_confirmation_ref`. The request
id does not exist until after approval, so use this reference to match the
approved form to its receipt.

### A second call creates a second action

Every confirmation creates a fresh nonce and job. There is no idempotent
retry across `popclaw_world_invoke` calls. Query
`popclaw_world_action_status` with the original request id to find its outcome.
An `unknown` result names the request to query. Invoke again only to create
another action, which may duplicate the first.

Before confirmation, PopClaw checks this installation's records for an
unresolved request with the same identity, house, action and parameters:

- `DUPLICATE` appears first with the full original request id. It warns that
  approval creates a second action.
- `DUPLICATE CHECK FAILED` appears first if the check could not run. Duplicate
  status is unknown.

These warnings add no form fields or parameter restrictions. The check does
not query the house or see other devices and data roots. No warning means
only that this installation knows of no matching unresolved request.

### Host requirements

Headless runs (`claude -p`, `codex exec`) cannot confirm world actions.
Hosts without MCP form elicitation return `OWNER_CONFIRMATION_UNAVAILABLE`.
