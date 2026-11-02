# Security

## How pre(f)light is meant to run

pre(f)light is a local tool. The server has **no login and no user separation**: anyone who can reach it can read, change and delete every venue. That's why the server and client only accept connections from the same machine by default. If you open them to your network (`--host` for the client, `HOST` for the server), do it only on a network where you trust everyone. Exposing it to the internet is not supported.

Websites you visit are kept out: the server refuses requests addressed to a host name it doesn't know (which stops DNS rebinding) and requests whose `Origin` doesn't match the host they're sent to (which stops other sites from sending requests, including WebSocket connections). Host names for network use are listed in `PREFLIGHT_ALLOWED_HOSTS`.

Because of that, "someone on my network can change my venues" is expected behavior, not a vulnerability.

## What to report

Please report problems such as:

- a way for a website to get a request accepted by the server despite the host and origin checks;
- reading or writing files outside the server's data folder (for example through a venue id or an upload);
- a crafted `.skp`, PDF or other upload that makes the server or converter run code or take over the machine;
- script injection in the client through venue names, fixture data or imported riders;
- an API key entered for the rider import leaking anywhere other than the AI provider it was meant for.

## How to report

Use GitHub's **private vulnerability reporting** (the "Report a vulnerability" button on the repository's Security tab), so the details stay private until a fix is out. Please don't open a public issue for it.

Include what you found, how to reproduce it and which version or commit you tested. This is a spare-time project, so there's no guaranteed response time, but reports will be read and answered.

## Supported versions

Only the latest code on the `main` branch gets fixes.
