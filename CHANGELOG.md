# Changelog

## Unreleased

- Add a task dispatch queue. `POST /api/task-queue` submits work from the signed-in Main Hub page, `GET /api/task-queue` lists it, and authenticated devices claim it with `POST /api/nodes/tasks/claim`, renew the lease with `beat`, and report one result with `ack`. `/api/tasks` keeps its existing meaning (scheduled Hub tasks).
- Tasks carry a lease: a worker that stops renewing loses the task after `leaseSeconds`, the queue retries it with backoff, and after three attempts it closes as `timeout` / `lease-expired`. A result that arrives from the attempt that expired is still accepted, marked `late`, so finished work is not thrown away and re-run.
- Fairness and bounds: claims prefer work this device did not already fail, queued tasks are capped, and finished tasks are pruned. Prompt, `cwd` (relative to the instance root), budget and timeout are validated on submission.
- Execution is injected and disabled by default: a Sub Hub without an executor never claims, so old nodes are unaffected. Protocol stays at version 1; task endpoints are additive and never ride in the existing `operations` array.

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
