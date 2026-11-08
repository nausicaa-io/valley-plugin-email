# Email

Built-in email client. Gmail and Microsoft accounts are signed in once in Settings → Accounts (shared with Calendar); generic SMTP/IMAP (PureMail) mailboxes are added here. Left-sidebar account/folder list, right-sidebar message preview, and a full workspace page to read, sync and compose.

Global Content Search includes synced message subjects, senders, recipients, and complete text/HTML bodies through the SDK dataset search contract. Settings → Search → Content Search controls Email independently. Selecting a result opens the message in its current account and folder. Messages must be synced before their content is searchable.

This repository owns the plugin’s interface, behavior, dependencies, schemas, tests, translations, and compiled releases. It uses Valley manifest API 5 and the injected SDK 6.

This is an external plugin and is not bundled with Valley. An installed copy lives in the realm's `.valley/plugins/packages/github/email/` (installed from GitHub) or `.valley/plugins/packages/local/email/` (installed from a local package). Core and external installations run with the same sandbox, permissions, and SDK/IPC contract. Ordinary realm documents and saved plugin data (`.valley/plugins/data/email/`) keep their existing locations.

## Filters and smart groups

Account and mailbox controls expand inline. Email resolves names and photos through Contacts, stores VIP addresses separately from message flags, and filters contact status, VIP, provider spam status, and virtual categories before SQLite pagination. The reader keeps one scroll area; full addresses and composer Cc/Bcc fields expand on demand.

Smart groups are set up on Email’s main Settings page and stored in the plugin data file `smart-groups.json`. Each account has its own tree of groups and subgroups; a group has a name, a decision sentence (“Put mail here when…”), and under More a confidence threshold (default 60 %) and “Always put mail from” rules (sender address, sender domain, or a Contacts entry). Rules decide first and need no provider. Otherwise Email asks the chosen classification provider through Valley’s shared classification API: any connection under AI Providers that offers classification (Jev, Laya, later providers) runs the same groups, and Email contains no provider-specific code. A group qualifies only at or above its threshold, its subgroups are considered only once it qualified, and the deepest qualifying group wins. The first start moves the former shared-group categories into every account with the same ids, so existing assignments keep resolving.

Laya runs separately on loopback; model installation and server lifecycle stay outside Valley. There is no automatic cloud fallback.

Smart groups are opt-in with one switch; turning it on gives accounts without groups a small set of starter groups, and an account whose groups were all removed is never sent to the provider. Automatic grouping applies to newly arrived, unread, non-spam Inbox messages after a sync baseline. Its default allowance is 100 messages per account in a rolling 24 hours. Initial syncs, historical imports, cache rebuilds, and UIDVALIDITY resets do not automatically enqueue old mail. Use Classify existing mail to select historical messages explicitly. Provider limits and budgets apply to both paths.

Categories never move messages or change spam status. Manual category assignments remain durable across cache rebuilds and block in-flight automatic results until Reset to automatic. Queue records contain identifiers and progress; provider input includes sender, subject, and normalized body without attachments or remote images. Interrupted or ambiguous requests require an explicit action before retrying.

## Automatic sends

Automatic sends inherit authenticated host causation. Email sets `Auto-Submitted` and its opaque origin header itself and retains a durable receipt before contacting SMTP; uncertain or completed attempts are not replayed. Automatic replies require complete, verified incoming headers and refuse automated, bulk, list, suppressed, or uncertain messages. Manual composing remains unchanged. Incoming header observations are retained through an additive cache migration; old messages without these observations need a fresh sync before automatic replies.

## Package

- `manifest.json`: readable English identity, version, and paired `author` / `authorUrl` arrays.
- `config.json`: runtime entry points, permissions, contributions, and storage declarations.
- `src/`: plugin interface and background engine.
- `locales/`: English, German, Spanish, French, and Simplified Chinese catalogs.
- `tests/`: package-owned checks using the portable SDK testkit.
- `runtime/`: compiled installation artifact, including the package’s locale catalogs.
- `vendor/`: pinned SDK, testkit, and build-tool archives for independent development.

The package’s `manifest.name` and `manifest.description` catalog entries translate its identity, including while disabled. Missing translations fall back to this package’s English catalog. A plugin never falls back to Valley’s catalog or another plugin’s catalog.

## Development and releases

Use Node 24.19.0 and npm 11.17.0. From this repository, run:

```sh
npm ci
npm run check
```

The check validates types and package boundaries, runs the package tests, and rebuilds `runtime/`. It requires no Valley source checkout. Keep the rebuilt runtime, locale files, dependency lock, and vendored tools with each release. Increment the package and manifest versions together.

Valley release maintainers explicitly import the compiled artifact into the application’s `plugins.lock.json`; building Valley does not build or read this repository. All privileged work uses declared SDK capabilities, authenticated IPC, and explicit grants. Disabling or unloading the plugin releases its subscriptions and resources.

## Workflow integration

The backend explicitly registers its supported blocks through `registerWorkflowContribution`. Workflow calls the owning operations with their original authentication, cancellation, grants, revisions, and receipts. The catalogue publishes Draft-07 parameter and port contracts; credential administration and approval bypasses are excluded. Workflow availability is configured separately in Workflow → Plugins. Existing account, connection, and profile settings remain owned by this plugin.

Workflow output collections are explicit: `listAccounts` → `$.accounts`, `listFolders` → `$.mailboxes`, `readFolder` → `$.messages`, `queryMessages` → `$.messages`, `parseAddresses` → `$.addresses`, `applyMessageAction` → `$.messages`. Selectors are relative to each execution item’s `json`. Folder listing deliberately selects structured mailboxes rather than the duplicate folder-name aliases. Message reads and message actions select the returned message list; single-message headers, addresses and attachment metadata remain attributes.
