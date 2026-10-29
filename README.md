# AIPA Hub

**English** · [简体中文](README_CN.md)

AIPA Hub 1.0.0 gives your private AIPA assistant a Web interface and an optional always-on service. Keep your knowledge and conversations in your own instance, choose a supported model executor, and access the assistant from your browser.

## Features

- Chat with context from your profile, memories and selected project, with source references and explicit missing-context errors.
- Capture quick notes, manage conversations and attachments, and retrieve relevant memories.
- Ask about images or public Web information when the provider and permission are configured.
- Create and review agenda items, daily reports and optional news briefings in the instance timezone.
- Review proposed memory changes and recover interrupted operations without silently repeating model requests.
- Connect an optional Sub Hub on another computer and synchronize the private instance through its own Git repository.
- Inspect service status, task activity, conflicts and recovery actions from the English Web interface.

The interface, source and command-line messages are English. Model replies can follow the user's language. Actual model, image and language support depends on your executor and provider.

## Web interface

Screenshots show an isolated demo instance with synthetic data and a fixed example reply.

### Chat with context

Continue conversations with relevant personal context and review the sources used in a reply. Keep earlier conversations within reach, and choose whether a turn may use Web search or image analysis.

![AIPA Hub conversation with a synthetic reading-assistant example](docs/screenshots/chat.jpg)

### Quick notes

Capture an idea immediately, add an image when useful, and revisit recent notes. Saving a note stores the original content in your instance without calling a model.

![AIPA Hub quick notes with a note composer and recent ideas](docs/screenshots/notes.jpg)

### Memory search

Search memories and saved notes by keyword. Results include excerpts and source locations so you can revisit the original context.

![AIPA Hub memory search showing memory and note results with source paths](docs/screenshots/memory.jpg)

### Runtime status

Check Main and Sub Hub availability, Core and Hub versions, synchronization state, and upcoming tasks. Filter the activity log to inspect actions and results.

![AIPA Hub runtime status with a synthetic device and activity log](docs/screenshots/runtime-status.jpg)

## Repositories

| Repository | Purpose |
|---|---|
| [Personal](https://github.com/StriveJ/artificial-intelligence-personal-agent) | Install the Core template and initialize your private instance |
| [Origin](https://github.com/StriveJ/artificial-intelligence-origin-agent) | Develop Core, skills, templates, tests and build tools |
| [Hub](https://github.com/StriveJ/artificial-intelligence-personal-agent-hub) | Run the Web service, scheduled work and optional Main/Sub connection |

Hub software, private instance data and device-local runtime configuration belong in separate directories. A single Main Hub is sufficient for Web access. An optional Sub Hub runs on another computer, connects outbound to Main and exposes local IPC without an HTTP listener. Each device uses its own private-instance checkout and local runtime.

## Installation

Install Node.js 24 or newer, Git 2.31 or newer, and a supported executor (`claude`, `codex` or the controlled `harness` adapter). Initialize an AIPA instance using the [Personal guide](https://github.com/StriveJ/artificial-intelligence-personal-agent#install) before starting Hub. Verify the executor with your intended model account; model usage may incur provider charges.

```sh
git clone https://github.com/StriveJ/artificial-intelligence-personal-agent-hub.git
cd artificial-intelligence-personal-agent-hub
npm ci --ignore-scripts
```

Copy `config.main.example.json` to a private directory outside the source repository, then edit it:

1. Set `root` to the initialized instance and `runtimeDir` to a separate private state directory. Use absolute paths.
2. Select your installed `engine`; keep its credentials outside this repository.
3. Decide the mode **before the first start**. Use `testMode: true` only with a disposable synthetic instance. For a real private instance, explicitly set `testMode: false`. Test mode permanently adds a no-push marker to the instance Git metadata; changing the setting later does not turn that instance into a production instance.
4. Review `tasks.repo-sync` and the instance's private Git remote before enabling synchronization. Disable that task if you do not want automatic Git operations.
5. Leave model-driven scheduled work disabled until you have reviewed its consent and privacy settings.

Start Main in the foreground:

```sh
node main-server.mjs --config /absolute/path/to/private/config.main.json
```

The example listens at `http://127.0.0.1:14327`. Open it locally to sign in and check status. Keep the terminal open, or configure your operating system's service manager to run the same command as a dedicated user. Stop with Ctrl+C before changing source or dependencies. The runtime directory contains pairing credentials, sessions and operation state; back it up privately with the instance.

### Remote access

Use an HTTPS reverse proxy or tunnel. Configure both `publicPort` (a separate loopback listener for the proxy) and `publicOrigins` (the exact allowed HTTPS origins) in the private Main configuration. Route the proxy to `publicPort`, not the local administrative listener. Retrieve the pairing code from the local page or SSH local forwarding; remote clients must pair. Keep the local administrative listener private. A tunnel alone does not authenticate Hub users.

### Optional Sub Hub

Install the same source on the other computer, prepare a separate checkout of the private instance, and copy `config.sub.example.json` to a private directory. Enroll the device in Main's Devices page and fill in `mainUrl`, `nodeId`, `installationId` and its device `token`. Set separate absolute instance/runtime paths and the locally available executor. For a real instance, set `testMode: false` before starting:

```sh
node sub-server.mjs --config /absolute/path/to/private/config.sub.json
```

The source Sub example deliberately omits `managedBase`, `programDir` and `externalInstance`. An ordinary source deployment supports synchronization and local IPC without enabling Main-requested remote clearing; a clear request returns a managed-installation requirement. Do not add these fields just to enable that action.

Managed lifecycle ownership is configured separately: a managed installer creates a dedicated installation directory and ownership records, validates instance/runtime/program paths, and requires an explicit binding for an external instance. Remote clearing deletes the instance and runtime paths owned by that installation. Use it only for a dedicated installation after reviewing that ownership and deletion scope. This source distribution does not supply a trusted managed package.

Never commit real configuration, device tokens, model credentials, pairing records, runtime files or signing private keys.

## Language and timezone

In the private instance's `user-space/overrides.yaml`:

```yaml
display:
  language: auto
```

`auto` follows the current input language, with English fallback. A valid BCP 47 tag such as `en`, `zh-CN` or `es` sets a preference; an explicit request in the current message takes precedence. Stored input, notes, quoted values and memories retain their original text. This setting does not translate the interface.

Set the shared IANA `time_zone` in `user-space/llm-provider.yaml`, such as `UTC` or `America/New_York`. Schedules and displayed timestamps use that zone. Leave Hub timezone overrides unset or identical to the shared value. The default is `Asia/Shanghai`.

## Updating

Update Hub software and Core separately. For a source installation:

1. Back up private configuration, runtime and instance data. Review the target version's release notes and requirements.
2. Stop this Hub process and confirm that no integrated task is still writing to the instance.
3. Keep the previous source directory for rollback. Fetch a reviewed tag into another source directory, check it out, and run `npm ci --ignore-scripts` there. Keep private instance and runtime paths unchanged.
4. Start the new source directory with the same private configuration. Check status, a conversation and notes before re-enabling scheduled work.
5. If validation fails, stop the new process and restore the previous source and matching private backups. Preserve any newly written data separately for review before restoring a snapshot.

Do not overwrite a running installation or delete private runtime state. Do not run `git pull` in the private instance to update Hub. Update Core through the [Personal update guide](https://github.com/StriveJ/artificial-intelligence-personal-agent#update-your-instance); updating Core does not update Hub.

This 1.0.0 distribution provides source. Managed installation and rollback tools are included for maintainers publishing signed immutable packages. A source tag does not provide a signed managed package or establish a trusted key. Use managed installation only when a release supplies an independently verified package, public-key fingerprint and installation instructions. See [package publishing](docs/release-process.md).

## Runtime contract and limits

<!-- aipa-support:hub:begin -->
| Hub contract | Source declaration |
|---|---|
| Program version / Node requirement | 1.0.0 / >=24 |
| Package dependencies | sharp 0.35.5 |
| Main/sub protocol range / Runtime format | 1–1 / schema 1 |
| Core capabilities required for shared context | context-projection-v1, context-completeness-v1, memory-lifecycle-v1, business-clock-v1, memory-usage-receipts-v1 |
<!-- aipa-support:hub:end -->

Installed Core declarations and configured services determine available capabilities. Required context or authorization failures block the affected operation. The default context budget is 1 MiB of input bytes, not a model token-window promise. Notifications mean Hub's durable inbox; operating-system push, email and SMS delivery are not included. Web token streaming, arbitrary Web command execution and remote fleet software updates are not included. See [scheduled work and notifications](docs/pushes.md).

Images use `sharp`; browser Markdown uses bundled Marked and DOMPurify. The controlled Harness adapter expects `@deepseek-ai/dsh` 0.2.1-rc.2 through `AIPA_HARNESS_ENTRY`. Installing Hub does not install an executor or grant model/network consent.

## Development

```sh
npm test
```

Core integration tests use a sibling `artificial-intelligence-origin-agent` checkout, or `AIPA_ORIGIN_ROOT` pointing to a public Origin checkout. Missing default source is explicitly skipped where supported; an invalid explicit path fails. Tests use synthetic fixtures and model stubs unless an optional controlled executor test is explicitly enabled. Do not point tests at a private instance.

## License

Original code and documentation use [Apache License 2.0](LICENSE), including its express patent grant and patent-litigation termination terms in Section 3. Third-party components retain their licenses; see [browser vendor notices](public/vendor/README.md). Installing Hub does not publish your private instance data.
