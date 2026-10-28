---
name: aipa-remind
description: Use when the user schedules, reschedules, cancels, completes, restores, or views agenda items. The host model interprets intent and the controlled Hub interface stores the same instance agenda.
---

# AIPA agenda

## Principles

Understand the actual user intent, original message time, and context. Distinguish confirmed arrangements, hypothetical plans, historical records, and undated to-dos. Check whether a same-name event is a duplicate, a new occurrence, or a reschedule. Only one-time items are supported. Clarify recurring requests, ambiguous dates, or multiple possible targets.

Do not ask again for the same action when the user already confirmed its exact content. Ask a concrete question for missing dates/times or ambiguous targets. Delete means soft cancellation. Completion and rescheduling use their corresponding actions. Casual chat, quotations, and assistant suggestions must not become agenda entries automatically. Preserve the original language of user input and titles. Respond in the user language or explicit requested language; interface messages and protocol fields remain English.

## Controlled commands

Run the installed `core-space/scripts/aipa-agenda.mjs` from the instance root. Local bindings select the main Hub or sub Hub IPC. The bridge does not store a second agenda or execute Git directly.

1. Read necessary candidates with `node core-space/scripts/aipa-agenda.mjs --command list`. Follow nextOffset using `--offset`; the first page is not the complete agenda.
2. Interpret the candidates and write a structured plan to a local temporary JSON file. Run `node core-space/scripts/aipa-agenda.mjs --command propose --id <stable-operation-id> --text <original-user-message> --consent --host-model <codex|claude|codebuddy|trae|deepseek> --host-plan <temporary-json-path>`. Sub Hubs reuse the host judgment without nested model calls. Without a host proposal, Hub uses its configured model. `--consent` means this specific content is authorized; never add it after refusal.
3. Return action(create/update/cancel/complete/restore/clarify/no_action), targetId, fields, message, and needsConfirmation. Reference only IDs actually read. Allowed fields are title, kind(event/deadline), priority(high/normal/low), event_at, end_at, time_zone, all_day, start_date, end_date_exclusive, and remind_at. Times require explicit offsets. Relative dates use the shared `time_zone` from `user-space/llm-provider.yaml`; its compatibility default is Asia/Shanghai. Ask for clarification when a daylight-saving wall time is ambiguous or nonexistent. Existing records retain their own timezone. A new item without an explicit advance reminder uses remind_at=null. Do not guess end times. Rescheduling an existing reminder requires the user to choose retention of its absolute time, a new reminder time, or cancellation; specify remind_at explicitly. Do not inherit silently or clear it arbitrarily.
4. For pending results, restate the specific action. Once exact user confirmation exists, run `node core-space/scripts/aipa-agenda.mjs --command confirm --id <returned-operation-id> --confirmed`. Model plausibility is not user confirmation.
5. Only applied means saved. Deferred means busy and not executed. Say that local data is saved and main-device display awaits synchronization; do not imply all devices received it.

If read compatibility is missing or agenda writes are paused, proposals remain available but cannot be applied. Never bypass the interface by editing files. After installation verification, retry confirmations that have not expired.

## Task gate

Commands started by run-instance-task inherit the current task lease. Native IDE hook sessions may use `--task-session <tool:host-session-id>` only when the ID matches the existing task. Never end or borrow another session task. Preserve input while another task is active; do not bypass the gate with file writes.

## Verification

List the agenda after creation, rescheduling, cancellation, or completion. Cancelled records remain in the full list and are not physically deleted. The main Hub selects the next three items and daily display deterministically; do not rewrite agenda facts with a model. Report incomplete operations as incomplete rather than claiming they were remembered.
