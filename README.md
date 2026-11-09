# Family Agenda WebUntis plugin

The WebUntis Source Type (`webuntis`) of [Family Agenda](https://github.com/artkoenig/family-agenda) as a stateless plugin container. It reads the Timetables of a parent account's children through the endpoints of the Untis Mobile app and answers the plugin contract over HTTP. It is built with the plugin kit (`docs/plugin-kit.md` of Family Agenda).

- Each request is authenticated with a one-time password (TOTP, RFC 6238) from the key of "Access through Untis Mobile" in the WebUntis profile.
- Each child of the account is a Source Attribute, under its Untis id; a child that joins is declared, one that goes is archived. A student's own account is read as its only child.
- Each run reads the next 14 days, today included, and states every Lesson whole, keyed by child and Untis's id, with its Timetable Change (cancellation, substitution, room change) as the Untis flags tell. A coming Lesson gone from the Timetable is withdrawn; a past one is forgotten. The sync cursor holds the children declared and the day of each Lesson read.
- Errors name a refusal by Untis's numeric code and a failed connection by its system error code only, never by a message, which could repeat parts of the request.
- Configuration (version 1): `server` (a host field, such as `park.webuntis.com`), `school`, `user`, `secret` (the key, secret).

## Running it

In `plugins.yml` of an Instance. The WebUntis server needs no egress entry: `server` is a host field, so the egress proxy allows the server an Admin enters.

```yaml
plugins:
  - id: webuntis
    image: ghcr.io/artkoenig/family-agenda-webuntis:0.1.0
```

The image listens on port 8080 and sets `NODE_USE_ENV_PROXY=1`, so every request leaves through the egress proxy in `HTTPS_PROXY`.

## Developing

Node 26 and pnpm (`corepack enable`). The plugin kit and the plugin contract are git dependencies on Family Agenda, pinned to one commit; raise both together.

- `pnpm install`
- `pnpm check`: typecheck, and the tests against recorded WebUntis responses, including the plugin kit's contract harness
- `pnpm start`: serves the plugin on `PORT` (8080)

## Releasing

Raise `version` in `package.json`, merge, and push the tag `vX.Y.Z` on main. CI then publishes `ghcr.io/artkoenig/family-agenda-webuntis` as `X.Y.Z` and `X.Y`.

## Licence

AGPLv3 (`LICENSE`). Contributions are licensed inbound as outbound under the [Developer Certificate of Origin](https://developercertificate.org/): sign off every commit (`git commit -s`). See `CONTRIBUTING.md`.
