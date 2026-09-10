# Email

Built-in email client. Gmail and Microsoft accounts are signed in once in Settings → Accounts (shared with Calendar); generic SMTP/IMAP (PureMail) mailboxes are added here. Left-sidebar account/folder list, right-sidebar message preview, and a full workspace page to read, sync and compose.

This repository owns the plugin’s interface, behavior, dependencies, schemas, tests, translations, and compiled releases. It uses Valley manifest API 5 and the injected SDK 6.

Valley ships this core plugin as a verified release artifact in its application resources. Core and external installations run with the same sandbox, permissions, and SDK/IPC contract. The core package and its locale files are never installed into `.valley`; ordinary vault documents and saved plugin data retain their existing locations.

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
