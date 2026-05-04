# snarkysyndo

Single-user micro-blogging client with no backend of its own. Messages are
committed to a GitHub repo; a GitHub Action picks up new messages and posts
them to Mastodon and Bluesky; a static page on GitHub Pages serves the
compose form and timeline.

```
  Browser (github.io)              GitHub repo                    Action runner
  ┌──────────────────┐   PUT       ┌───────────────┐   on push    ┌────────────────────────┐
  │ Compose textarea ├────────────▶│ messages/*.md ├─────────────▶│ post_messages.py       │
  │ + timeline view  │  /contents  │   (frontmatter│              │   → Mastodon /statuses │
  │                  │             │   tracks      │              │   → Bluesky createRecord│
  │ PAT in localStg  │◀────────────┤   posted_at)  │◀─────────────┤   → commit status back  │
  └──────────────────┘  list/raw   └───────────────┘   git push   └────────────────────────┘
```

## Repo layout

```
messages/         message files, one per post (markdown + YAML frontmatter)
docs/             static client app, served by GitHub Pages
action/           Python posting script (PEP 723 inline metadata, run via uv)
.github/workflows GitHub Actions workflow that runs the script
```

## One-time setup

### 1. Create the repo

Push this repo to GitHub. The default branch can be `main` or `master` — the
workflow handles both.

### 2. Mint a Mastodon access token

On your Mastodon instance: **Preferences → Development → New application**.

- Application name: `snarkysyndo` (anything works)
- Scopes: `write:statuses` is sufficient (uncheck the others if you want
  least privilege)
- Save, then copy the **access token** from the application detail page.

### 3. Mint a Bluesky app password

On Bluesky: **Settings → Privacy and security → App Passwords → Add App
Password**. Name it `snarkysyndo`. Copy the generated password (it will
look like `xxxx-xxxx-xxxx-xxxx`).

### 4. Add the secrets to the GitHub repo

In the repo on github.com: **Settings → Secrets and variables → Actions →
New repository secret**. Add four secrets:

| Name                   | Value                                                       |
|------------------------|-------------------------------------------------------------|
| `MASTODON_INSTANCE`    | host name only, e.g. `mastodon.social` (no scheme, no path) |
| `MASTODON_TOKEN`       | the access token from step 2                                |
| `BLUESKY_HANDLE`       | your full handle, e.g. `you.bsky.social`                    |
| `BLUESKY_APP_PASSWORD` | the app password from step 3                                |

You can omit one platform's pair if you only want to post to the other; the
script no-ops platforms whose creds are absent.

### 5. Enable GitHub Pages

**Settings → Pages → Build and deployment**: source = **Deploy from a
branch**, branch = your default branch, folder = `/docs`. After the first
deploy your client will live at
`https://<your-user>.github.io/<repo-name>/`.

### 6. Mint a fine-grained PAT for the browser client

GitHub: **Settings (under your Profiler picture, upper right) →
Developer settings → Personal access tokens →
Fine-grained tokens → Generate new token**.

- **Resource owner**: yourself (or the org that owns the repo)
- **Repository access**: *Only select repositories* → pick this repo
- **Permissions**: under *Repository permissions* set **Contents: Read and
  write**. Everything else stays *No access*.
- Expiration: whatever you're comfortable with. The token only lives in
  your browser's localStorage.

Copy the token (you only see it once).

### 7. First use

1. Open `https://<your-user>.github.io/<repo-name>/`.
2. Click **Settings**, paste the PAT, fill in repo owner/name and branch.
3. Click **Test** to verify access. **Save**.
4. Type a message, **Post**. Within a minute or so the action will run and
   the message's badge in the Timeline will switch from `pending` to
   `posted` with links to the live Mastodon and Bluesky posts.

## Day-to-day

- **Post**: type, click Post. The browser commits the file; the action
  publishes.
- **See history**: Timeline lists recent messages with their status and
  links to the live posts.
- **A platform failed**: the message will sit at `partial` or `failed`
  with the error visible. To retry, go to **Actions → post-messages →
  Run workflow** in the GitHub UI. The script only re-attempts the
  platform that has no URL yet.

## Message file format

```yaml
---
id: 20260101T000000Z-example
created_at: '2026-01-01T00:00:00Z'
posted_at: null
mastodon_url: null
bluesky_url: null
mastodon_error: null
bluesky_error: null
---
The body of the post goes here.
```

`posted_at` is set only after every configured platform has succeeded. A
per-platform success is recorded as a URL; a failure is recorded as a
short string in `*_error` so the next run knows what to retry.

## Local development

You can run the action locally against a checked-out copy of the repo:

```sh
export MASTODON_INSTANCE=mastodon.example
export MASTODON_TOKEN=...
export BLUESKY_HANDLE=you.bsky.social
export BLUESKY_APP_PASSWORD=...
uv run action/post_messages.py
```

`uv` resolves the script's PEP 723 inline dependencies on first run.

## Security notes

- The browser PAT lives only in localStorage on your device. Don't paste
  it on a shared machine; use the **Forget** button in Settings to wipe
  it.
- Use a fine-grained PAT scoped to *just this repo* — a leaked token is
  then limited to one repo with `Contents: write`.
- Mastodon and Bluesky credentials live in GitHub Secrets and are never
  exposed to the browser client.
- The action's commits include `[skip ci]` so its status updates do not
  re-trigger the workflow.
- The client ships a strict Content Security Policy (`connect-src` is
  pinned to `api.github.com`) and refuses to render non-`https:` links
  from message frontmatter, so a corrupted or hostile message file
  cannot navigate the page to a `javascript:` URI.
- **Shared-origin caveat:** every site under `https://<your-user>.github.io/`
  shares the same browser origin and therefore the same localStorage. If
  you publish *any* other GitHub Pages site under the same user, that
  site can read this PAT. Mitigations, in order of preference:
  1. Don't publish other Pages sites under the same user account, or
  2. Serve snarkysyndo from a custom domain (Pages → Custom domain) so
     it gets its own origin, or
  3. Click **Forget** in Settings after each session — re-pasting the
     PAT each time eliminates persistent storage at the cost of UX.

## Limitations (v1)

- Text only, no images.
- 300-character cap (Bluesky's limit; Mastodon's is more generous but
  300 is the strict floor).
- No editing, deletion, threading, or scheduling. A `messages/*.md` file
  whose `posted_at` is set is final.
- Timeline pulls every file in `messages/` on each refresh — fine for
  hundreds of posts; would want pagination at thousands.
