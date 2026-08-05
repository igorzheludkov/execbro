# Network Mocking — Tutorial

Change what the network returns, so your app runs its **real** error code.

Most error paths are hard to reach: you cannot ask a production API for a 500,
and a null field only shows up for one unlucky customer. The usual workaround is
to write the post-failure state directly into the store — which skips the
request builder, the error branch, the retry and the toast, i.e. exactly the
code you are trying to test.

These three tools change the response instead, so everything downstream is real:

| Tool | What it does |
|------|--------------|
| `network_mock` | Replace a response, or modify the real one |
| `network_condition` | Simulate offline / slow / normal |
| `network_replay` | Re-issue a request the app already made |

## Quick Start

```
scan_metro
network_mock with action="add" url="/orders" status=500
# reproduce the action in the app
get_network_requests with urlPattern="/orders"    # row shows [MOCK m1]
network_mock with action="clear"
```

That is the whole loop: **add → reproduce → look → clear.**

---

## Example 1: Does this screen handle a 500?

The most common question, and usually the fastest bug to find.

```
network_mock with action="add" url="/api/orders" status=500 body="{\"error\":\"server error\"}"
tap with text="Orders"
get_screen_state
```

If `get_screen_state` shows a spinner that never stops, or an empty list with no
message, that is your finding — the screen has no error state. You just proved it
without touching the backend.

Clean up when done:

```
network_mock with action="clear"
```

## Example 2: What if this field is missing?

`replace` returns a canned body. Often you want the **real** response with one
thing changed — that is `tamper`.

```
network_mock with action="add" url="/api/me" mode="tamper" remove=["data.avatarUrl"]
reload_app
```

The app gets its genuine profile response, minus `avatarUrl`. If the avatar
component crashes on `undefined`, you have found a real crash with a realistic
payload rather than a hand-written stub.

Setting values works the same way, with dotted paths:

```
network_mock with action="add" url="/api/me" mode="tamper" set={"data.subscription.status": "expired"}
```

Now you can see the expired-subscription UI without an expired account.

## Example 3: Does my retry actually work?

`times` fires a rule a limited number of times, then lets traffic through. With
`times=1`, the first attempt fails and the second succeeds — which is precisely
the situation retry logic exists for.

```
network_mock with action="add" url="/api/sync" status=503 times=1
tap with text="Sync"
network_mock with action="list"
```

The list shows `hits=1` and `(times:1, spent)`. If the app recovered, your retry
works. If it showed an error and stopped, it does not retry at all.

## Example 4: What happens with no network?

```
network_condition with mode="offline"
tap with text="Refresh"
get_screen_state
network_condition with mode="normal"
```

Every JS-originated request now fails the way a real connection drop fails.

If your app gates its offline UI on `useNetInfo()` rather than on a failed
request, `offline` also tries to patch NetInfo, and tells you what it managed:

- `patched` — existing subscribers were notified, your offline banner should appear
- `reads-patched-only` — `NetInfo.fetch()` reports offline, but already-mounted components were not re-rendered
- `not-installed` — the app does not use NetInfo, which is fine

Requests fail in all three cases.

## Example 5: Is there a loading state?

Real APIs answer too quickly on a dev machine to see the spinner.

```
network_condition with mode="slow" latencyMs=3000
tap with text="Search"
ios_screenshot
network_condition with mode="normal"
```

Three seconds is plenty of time to catch a missing skeleton, a button that can be
double-tapped while in flight, or a spinner that never appears.

## Example 6: Re-run a request that failed

Your app POSTed something and got a 422. Instead of navigating back through the
form to try again, replay it:

```
get_network_requests with status=422
network_replay with requestId="js-a1b2-7"
network_replay with requestId="js-a1b2-7" body="{\"quantity\":1}"
```

Change one field at a time and you will find what the backend actually objects
to, in seconds. The replay goes through the app's own network stack, so it
carries the same auth, TLS trust and proxy settings as the original.

---

## Always clean up

Rules are **per-device** and **survive `reload_app`** — that is deliberate, since
a mock that vanished on reload would be useless for startup bugs. But it means a
forgotten rule silently affects your next debugging session, and the symptom
looks exactly like a real bug.

```
network_mock with action="clear"
network_condition with mode="normal"
```

While any rule is active, every network read ends with a banner naming the count.
Believe it.

## Troubleshooting

**My rule is not firing.** Check `network_mock with action="list"`. Matching is
first-rule-wins, so a broad rule added earlier shadows a specific one added
later. A rule showing `hits=0` when you expected it to fire is almost always
shadowed.

**The URL is not matching.** `url` is a plain substring by default — `"/orders"`
matches `https://api.example.com/v2/orders/17`. For anything more precise, wrap
the pattern in slashes to make it a regex: `"/\\/orders\\/\\d+$/"`.

**Nothing is intercepted at all.** Mocking covers JS-originated HTTP only.
Traffic from native modules — native analytics SDKs, `<Image>` loading, anything
that never touches `XMLHttpRequest` — goes around it. If you just upgraded
execbro, `reload_app` once: a JS context keeps whatever interceptor it started
with.

**Tamper says the response was not JSON.** `set` and `remove` need a JSON body.
The response was passed through untouched rather than mangled. Use `bodyReplace`
to swap the whole body regardless of format.

---

Full parameter reference: [Network Tracking](network.md#changing-responses).
