# Changelog

## Unreleased

- Advertise a member identity from a Sub Hub (`member.name`, `member.aliases`, `member.persona`). The Main Hub stores it with the device, returns it from `GET /api/nodes`, and resolves device operations (`sync` / `clear` / `offline`) by member name or alias as well as by the stable device ID.
- Member names are unique across live devices and are released when a device is removed. Names and aliases are 1-40 letters, digits, spaces, dots, hyphens or underscores. Persona is limited to presentation fields (`tone`, `initiative`); unknown fields are refused. Devices that never advertise a member behave exactly as before, and the Main/Sub protocol stays at version 1.

## 1.1.0

- Add English and Simplified Chinese interface switching with browser-language detection, persistent browser preferences, and immediate updates that preserve drafts and unsaved form fields.
- Register default interface messages in one table, generate complete translation templates, and derive language menus, matching, and asset routes from a shared registry. Validate message coverage and numbered placeholders.
- Add optional public website footer text, a Chinese ICP filing link, and up to eight legal links. Keep deployment values private, persist edits in device-local runtime, and render configured information before sign-in and without JavaScript.
- Preserve original conversations, model output, code examples, custom names, and configured legal text during interface changes. Keep model response-language preferences independent.

Source upgrades keep existing private configuration and runtime directories. Restart Hub and reload the browser after updating. Footer fields default to empty; no actual filing number is included. Core 1.0.3 is the pinned integration-test baseline. Runtime schema and Main/Sub protocol remain at version 1.

## 1.0.1

- Respect disabled repository synchronization during report closing and backfill while preserving local report generation.

## 1.0.0

Initial public source release.

- Browser chat with shared Core context, memory sources, project scopes and explicit privacy boundaries.
- Quick notes, conversations, image attachments and optional public Web questions.
- Agenda management, daily reports and optional news briefings in the shared instance timezone.
- Optional Main/Sub operation with private-instance Git synchronization and task exclusion.
- Durable receipts, conflict review, interrupted-operation recovery and maintenance tooling.
- English interface and command-line messages, with model response-language preferences that preserve original stored content.
- Apache-2.0 license with its express patent grant and retained third-party notices.

This distribution provides source. Managed packages require separate publisher signing, independently verified trust and release-specific installation instructions.
