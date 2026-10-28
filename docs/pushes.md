# Scheduled work and notifications

## Daily news

`lib/briefings.mjs` implements daily news; `lib/news-sources.mjs` provides registered public-source adapters. Categories are AI, economy, public policy, and headlines. Built-in sources include OpenAI, the State Council of China, and China News Service RSS feeds. Links come from collection results; the model summarizes by ID and cannot generate links. Summary language follows the shared response-language preference; the interface remains English.

Daily news is disabled on fresh installations. The default schedule is 07:00 in the shared instance timezone (Asia/Shanghai by default). Set `time_zone` in `user-space/llm-provider.yaml` to an IANA zone such as `UTC`, `America/New_York`, or `Asia/Kathmandu`; leave Hub timezone overrides unset or identical to this shared value. News, agenda digests, relative agenda dates, report boundaries, quotas, and displayed timestamps use this same zone. Daily schedules run once at the earlier occurrence of an overlapping wall time. A nonexistent wall time shifts forward by the transition gap (for example, 02:30 becomes 03:30 for a one-hour DST gap). Existing agenda items retain their recorded zones and absolute instants. The UI shows the active zone and does not change personal configuration files. The Notifications page can change categories, sources, time, interests, or enabled state. Settings are stored outside the repository in briefing-settings.json and apply to later briefings. Completed briefings are not regenerated or billed repeatedly for the same day.

A task started after its scheduled time catches up once for the current day. Runtime duration does not shift later daily schedules. After multi-day downtime, only the latest run is recovered. Failures retry every 15 minutes, up to three attempts. Active conversations or repository maintenance defer generation by one minute. News and chat use the same serialized model runner. News sends only public materials and explicitly supplied interests, without personal profiles, memories, or conversation history.

Collection normally covers 48 hours; policy sources may include 14 days and retain original publication dates. Previously delivered links are deduplicated for seven days. Current configurable limits are declared by `MAX_ITEMS` and the settings API; summaries are batched in groups of 25. Interest/exploration ranking defaults to 70/30. Headlines are selected-source highlights rather than a global trending ranking. Summaries use supplied titles and excerpts and do not imply full-page access or exhaustive coverage. Individual source failures are disclosed; total source failure is retried. Model failure preserves labeled source excerpts with original links.

## Data and API

- `user-space/logs/hub/pushes/<id>.json`: generic notification envelope with type, title, summary, and payload.
- `user-space/logs/hub/briefings/YYYY-MM-DD.{json,md}`: briefing data and readable source links.
- These records are in the existing Hub log synchronization scope and use the configured repository schedule.
- Runtime `push-reads.json` stores this Hub read state outside the repository.
- `GET /api/pushes`, `GET /api/pushes/:id`, and `POST /api/pushes/:id/read` expose the inbox.
- `GET/POST /api/briefing-settings` and `GET /api/briefings/:day` expose settings and details.
- `POST /api/pushes/daily-briefing/run` manually triggers the registered daily briefing task; it cannot execute arbitrary producer types.

Personal endpoints require pairing and mutations require same-origin checks. Notifications here mean the durable Hub inbox and unread indicators available while the page is open; there is no operating-system, email, or SMS delivery.

Validate using `node --test tests/hub.test.mjs tests/tasks.test.mjs tests/pushes.test.mjs`. Tests use synthetic sources and model stubs and send no real personal information.
