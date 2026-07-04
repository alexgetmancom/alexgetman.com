# alexgetman.com migration notes

## Site changes

- Astro `site` is now `https://alexgetman.com`, so canonical URLs, sitemap URLs, RSS links and `robots.txt` are generated for the new domain.
- Hard-coded public URLs in JSON-LD, Open Graph image URLs, OpenAPI/auth docs and feed fallbacks now point to `https://alexgetman.com`.
- The Twitch embeds use `parent=alexgetman.com`.
- The default feed collector `PUBLIC_BASE_URL` is `https://alexgetman.com`.

## Server checklist

1. Point nginx at the existing public directory `/home/deploy/ialexey-web`.
2. Install a certificate for both names:

   ```bash
   sudo certbot --nginx -d alexgetman.com -d www.alexgetman.com
   ```

3. Use `deploy/nginx/alexgetman.com.conf.example` as the new server block, then test and reload:

   ```bash
   sudo nginx -t
   sudo systemctl reload nginx
   ```

4. Update `/home/deploy/ialexey-feed/ialexey-feed.env`:

   ```dotenv
   PUBLIC_BASE_URL=https://alexgetman.com
   ```

5. Restart the feed service and update the Telegram webhook:

   ```bash
   sudo systemctl restart ialexey-feed
   docker compose -f /opt/alexgetman-posting/compose.yaml exec -T site-feed python3 -m site_feed.cli set-webhook
   ```

## Cloudflare DNS

Cloudflare proxy status is per DNS record, not per visitor country. A single hostname cannot be DNS-only for Russia and proxied for everyone else in normal Cloudflare DNS.

Practical options:

- Compatibility-first: set `alexgetman.com` and `www` to DNS-only. This gives direct origin access for Russia and everywhere else.
- Cloudflare-first: set `alexgetman.com` and `www` to proxied. This gives CDN/WAF features globally, but Russian visitors may have Cloudflare reachability issues.
- Split-hostname: keep `alexgetman.com` proxied and create `ru.alexgetman.com` as DNS-only. This only helps users who know or receive the RU hostname.

Recommended for the requirement as stated: use DNS-only for `alexgetman.com`/`www`, because reliable access from Russia conflicts with Cloudflare proxying on the same hostname.

DNS records:

```text
alexgetman.com      A      5.129.238.194    DNS-only
www.alexgetman.com  CNAME  alexgetman.com   DNS-only
```

If IPv6 is configured on the server, add:

```text
alexgetman.com      AAAA   <origin IPv6>    DNS-only
```
