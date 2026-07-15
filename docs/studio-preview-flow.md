# Studio publication preview flow

Studio owns a transport-neutral publication flow:

```text
draft → validate → delivery projections → publish/schedule → jobs → events → status
```

`DeliveryProjection` is the shared preview contract. It contains the target group, locale, transformed text, selected media, target metadata and declared delivery deviations. It is produced from Studio content and platform profiles; interfaces do not recreate publishing rules.

## Telegram

Telegram renders projections as ordinary messages at the bottom of the conversation, without inline controls on the content itself:

1. one canonical RU content preview;
2. one canonical EN content preview when EN targets exist;
3. additional previews only where delivery differs materially (for example X URL removal, Stories first/vertical asset, Dev.to cover);
4. a separate confirmation card with targets and schedule;
5. after confirmation, a new live-progress card.

The confirmation and progress cards are never used as content previews. The draft editor, confirmation and progress have separate interface bindings. Delivery events refresh the progress card; the draft editor remains historical context.

Video previews are target projections: YouTube Shorts shows the source video plus title, description, tags and optional game URL; Instagram Reels shows the source video plus caption. Future locale variants add target-and-locale projections rather than a Telegram-specific workflow.

## MCP and CLI

MCP `studio_post_preview` and `studio_video_preview` return the same `delivery` projections. An agent reads `validate` and `preview`, then may publish or schedule autonomously. It does not require Telegram confirmation. MCP mutations retain owner checks and an `mcp` audit event.

A future CLI prints this same contract. Telegram may receive event-driven status cards for an agent run, but the agent never edits Telegram messages itself.

## Compatibility

Old Telegram message ids and cards remain readable only for historical data. New preview, progress and interface state use neutral Studio data and `interface_bindings`.
