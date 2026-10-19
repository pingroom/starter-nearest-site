# PingRoom nearest site starter

Turn a map point shared by a trusted teammate into a service site suggestion. The script compares the point with your local catalog, previews the nearest eligible destination, and sends its map card only when you supply the reviewed plan's hash.

A shared point can be placed anywhere on a map. It is not proof of a person's current location or presence. Distances are approximate straight-line distances calculated with the Haversine formula, not driving distances or travel times. An enabled catalog entry does not establish current opening hours, stock, or service availability. This starter suggests a destination; it does not dispatch anyone.

## Try it offline

Requires Node.js 22 or newer. Choose **Use this template**, clone your repository, then:

```sh
npm ci
npm run demo
npm test
```

The demo uses the real SDK with an in-memory transport and fictional coordinates. It previews a site without sending, sends a simulated map card, and repeats the operation without a duplicate. It reads no credentials, makes no network requests, and deletes its temporary files. Installation needs npm access.

## Configure your workflow

1. [Install PingRoom](https://pingroom.io/i). Use a standard private room with at least two human members.
2. Run `npm run connect`, approve the printed link, and grant that room. Select another granted room with `npm run connect -- --room ROOM_CODE`.
3. Copy `catalog.example.json` to ignored `catalog.local.json`. Replace the sample sender UUID with your trusted teammate's user UUID, and replace the fictional sites with your own. Room-member IDs are available from the SDK's `rooms.list()` response; use the member's `user_id`, not their display name or an agent ID.
4. Have that person deliberately share a location in the room. Supply that notification's UUID from your application event or PingRoom notification link.
5. Preview the suggestion, inspect the destination and payload, then optionally send it:

```sh
npm start -- SOURCE_NOTIFICATION_UUID
npm run send -- SOURCE_NOTIFICATION_UUID REVIEW_HASH
```

`npm start` is read-only against PingRoom and saves a private local plan. `send` rechecks the room, sender, point, age, and catalog before broadcasting once to the same room. It never fetches URLs, geocodes addresses, follows people, or contacts another service. The map card contains the selected site's coordinates; the source point stays in the existing source ping and private local plan.

Catalog fields:

- `trustedSenderIds`: 1–100 distinct human UUIDs allowed to supply points.
- `maxAgeSeconds`: 60–86400. Future timestamps and older shares are rejected; keep your machine's clock accurate.
- `maxRadiusKm`: greater than zero, at most 1000. Only enabled sites within this straight-line radius qualify.
- `sites`: at most 100 entries with unique IDs, printable ASCII names up to 40 characters, finite numeric coordinates, and an `enabled` boolean. Empty catalogs are allowed and produce `no_site`.

Latitude must be between -90 and 90, longitude between -180 and 180. Site IDs use 1–64 letters, digits, `_` or `-`, starting with a letter or digit. Names cannot have leading or trailing spaces. Equal distances within a micrometre are resolved by site ID. Catalog order never changes the result. No eligible site means no send.

The connection needs `pingroom:rooms:read`, `pingroom:notifications:read`, and `pingroom:broadcast:send`, plus the room grant. Pairing grants are server-controlled. Sending requires the connecting human to be owner/admin, or the room to allow everyone to trigger; sending quotas apply. Avoid changing room visibility while processing a share. API acceptance does not prove phone delivery.

## Credentials and local files

Pairing saves ignored `.pingroom/credentials.json`. Alternatively, copy `.env.example` to `.env` and fill both `PINGROOM_TOKEN` and `PINGROOM_ROOM`. Shell variables take precedence. A full environment pair overrides saved credentials; a partial or blank pair fails. `CATALOG_FILE`, `STATE_DIR`, and `RECEIPT_DIR` customize paths. Relative paths and `.env` resolve from this project directory.

Plans in `.plans/` contain the shared coordinates and sender UUID. Delivery receipts in `receipts/` contain the chosen destination, source notification ID, and hashes. Files use `0600` and directories `0700` on POSIX; use equivalent private permissions on Windows. Keep these directories private and archive them together. Catalog and credential reads are bounded to 64 KiB and 16 KiB; invalid UTF-8 or JSON is rejected without printing its contents.

## Replay and uncertain sends

A source notification is bound to its room and connection. An unsent plan may be recomputed after catalog changes; its new hash invalidates the previous review. Once sent, repeated commands return the historical receipt without another broadcast. They do not assert that the source is still fresh or the site is still available.

The journal is written and synced before the POST. Any lost response or invalid send result leaves `send_unknown`; subsequent plans and sends issue no further POST. Find the existing suggestion in PingRoom or your authorized notification history, then explicitly attach its UUID:

```sh
npm run recover -- SOURCE_NOTIFICATION_UUID SENT_NOTIFICATION_UUID
```

Recovery reads the candidate and checks the room, source reference, reviewed destination, correlation, and agent provenance. It does not send. An empty history result is not proof that nothing was delivered. Keep uncertain state and investigate; deleting it and retrying can duplicate a suggestion. There is no exactly-once delivery guarantee.

Only one process may use a state directory. After a crash, verify no process is using it before removing `.plans/.lock`. Corrupt state requires a valid backup. The directory allows 100 source notifications; archive completed state and receipts without replaying archived source IDs. Different receipt contents are never overwritten. Keep the same connection while a plan or uncertain send is outstanding.

Each API request has a five-second timeout. Plan/send make two reads, and send adds one POST; recovery makes two reads. Exit codes: `0` planned, sent, recovered, or already sent; `2` no eligible site; `3` uncertain send; `1` invalid input, access, storage, or API failure.

## Adapt it

Import `runNearest` from `src/nearest.js` with an SDK client, catalog, source UUID, connection, and storage paths. Keep `operation: 'plan'` as the default and pass the returned `reviewHash` for `operation: 'send'`. Feed explicit location-share IDs from your existing workflow. The catalog is the only site source; add your own business rules in application code before producing a reviewed plan.

SDK `0.6.0` is pinned with a lockfile and a 14-day release-age policy. CI runs the credential-free tests and demo on Node.js 22 and 24. [Official SDK documentation](https://github.com/pingroom/sdk) · [MIT license](LICENSE)
