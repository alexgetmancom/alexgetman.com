# Studio Core — план

## Цель

Превратить проект из набора бота, worker'ов и сайта в независимую content platform.

```text
Content → Publishing → Delivery → Analytics
                  ↓
            Studio Services
                  ↓
Telegram · Command Center · MCP
```

## Домены

```text
Content
  drafts · articles · media · locales · translations

Publishing
  plans · targets · schedules · publication state · jobs

Delivery
  social APIs · site builds · video workers · media preparation

Analytics
  collectors · snapshots · deltas · profiles · read models

Interfaces
  Telegram · Command Center · MCP

Cross-cutting
  db · config · runtime · observability · domain events
```

## Правила

1. Interface не ходит в БД, workers или social APIs напрямую.
2. Interface вызывает только Studio Services.
3. Studio Services применяют owner-check, policy, audit и возвращают данные.
4. Domain Core не знает о Telegram-кнопках, callback'ах и UI-текстах.
5. Delivery не знает о UI; Analytics не знает о конкретном renderer'е.
6. Важные изменения пишут domain event.

## Порядок работ

1. Physical Content extraction из исторического `bot/`.
2. Собрать Delivery в один контекст: workers, site, social, video, media.
3. Дочистить Publishing как границу Content → Delivery.
4. Выделить Analytics engine из Telegram presentation.
5. Расширить domain events на Content, Publishing, Delivery и Analytics.
6. Закрепить границы dependency tests.
7. Новые фичи добавлять как feature-модули поверх этого ядра.

## Не цель сейчас

- не делать Web Studio;
- не делать новый мессенджер-интерфейс;
- не переписывать рабочую БД, очередь и publishers;
- не добавлять AI-логику в Telegram handlers.

## MCP

MCP — тонкий interface над Studio Services.
AI не получает SQLite, worker-доступ или social tokens.
Все действия проходят owner-check и пишутся в audit trail.
