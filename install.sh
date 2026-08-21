#!/bin/sh
# Solo Publisher installer.
#
#   curl -fsSL https://raw.githubusercontent.com/alexgetmancom/solo-publisher/main/install.sh | sh -s -- publisher.example.com
#
# Does what the README's Install section describes, in one command: checks
# Docker and that the domain resolves to this machine, writes .env with
# generated secrets, starts the stack, waits for /readyz through Caddy, and
# prints the Command Center URL. Re-running it keeps the existing .env and
# updates the stack.
set -eu

REPO_RAW="https://raw.githubusercontent.com/alexgetmancom/solo-publisher/main"
DIR="solo-publisher"
DOMAIN=""
SKIP_DNS_CHECK=0

die() { printf '\nerror: %s\n' "$*" >&2; exit 1; }
say() { printf '%s\n' "$*"; }
step() { printf '\n==> %s\n' "$*"; }

usage() {
	cat <<'USAGE'
Usage: install.sh <domain> [--dir <path>] [--skip-dns-check]

  <domain>          hostname this Studio answers on; must already resolve here
  --dir <path>      install directory (default: ./solo-publisher)
  --skip-dns-check  install before DNS points here (TLS fails until it does)
USAGE
}

while [ $# -gt 0 ]; do
	case "$1" in
		-h|--help) usage; exit 0 ;;
		--dir) [ $# -ge 2 ] || die "--dir needs a path"; DIR="$2"; shift 2 ;;
		--skip-dns-check) SKIP_DNS_CHECK=1; shift ;;
		-*) usage >&2; die "unknown option: $1" ;;
		*) [ -z "$DOMAIN" ] || die "one domain, got '$DOMAIN' and '$1'"; DOMAIN="$1"; shift ;;
	esac
done

[ -n "$DOMAIN" ] || { usage >&2; die "no domain given"; }
case "$DOMAIN" in
	*[!a-zA-Z0-9.-]*|.*|*.|*..*|*[!a-zA-Z0-9]) die "'$DOMAIN' is not a hostname" ;;
	*.*) : ;;
	*) die "'$DOMAIN' has no dot; a certificate needs a real domain" ;;
esac

# --- prerequisites ------------------------------------------------------
step "Checking prerequisites"
command -v curl >/dev/null 2>&1 || die "curl is required"
command -v docker >/dev/null 2>&1 || die "Docker is not installed: https://docs.docker.com/engine/install/"
docker info >/dev/null 2>&1 || die "the Docker daemon is not reachable (start it, or add this user to the docker group)"
docker compose version >/dev/null 2>&1 || die "Docker Compose v2 is missing; 'docker compose version' must work"
say "Docker and Compose are ready."

# --- DNS ----------------------------------------------------------------
resolve_domain() {
	if command -v getent >/dev/null 2>&1; then
		getent ahostsv4 "$1" 2>/dev/null | awk '{print $1}' | sort -u && return 0
	fi
	if command -v dig >/dev/null 2>&1; then
		dig +short A "$1" 2>/dev/null | grep -E '^[0-9.]+$' && return 0
	fi
	if command -v host >/dev/null 2>&1; then
		host -t A "$1" 2>/dev/null | awk '/has address/ {print $NF}' && return 0
	fi
	return 1
}

if [ "$SKIP_DNS_CHECK" -eq 1 ]; then
	step "Skipping the DNS check"
else
	step "Checking that $DOMAIN points at this machine"
	public_ip="$(curl -fsS --max-time 10 https://api.ipify.org 2>/dev/null || true)"
	resolved="$(resolve_domain "$DOMAIN" || true)"
	[ -n "$resolved" ] || die "$DOMAIN does not resolve. Point an A record at this machine, or pass --skip-dns-check."
	if [ -z "$public_ip" ]; then
		say "Could not determine this machine's public address; $DOMAIN resolves to: $(echo "$resolved" | tr '\n' ' ')"
	elif echo "$resolved" | grep -qx "$public_ip"; then
		say "$DOMAIN resolves to $public_ip. Good."
	else
		die "$DOMAIN resolves to $(echo "$resolved" | tr '\n' ' ')but this machine is $public_ip.
Fix the A record (certificate issuance fails otherwise), or pass --skip-dns-check."
	fi
fi

# --- files --------------------------------------------------------------
step "Installing into $DIR"
mkdir -p "$DIR"
cd "$DIR"
for f in compose.yaml Caddyfile; do
	curl -fsSL "$REPO_RAW/$f" -o "$f.tmp" || die "could not download $f from $REPO_RAW"
	mv "$f.tmp" "$f"
done
say "compose.yaml and Caddyfile are current."

# --- .env ---------------------------------------------------------------
secret() {
	if command -v openssl >/dev/null 2>&1; then
		openssl rand -hex 32
	else
		od -An -tx1 -N32 /dev/urandom | tr -d ' \n'; echo
	fi
}

if [ -f .env ]; then
	step "Keeping the existing .env"
	COMMAND_CENTER_TOKEN="$(sed -n 's/^COMMAND_CENTER_TOKEN=//p' .env | head -n 1)"
	current_domain="$(sed -n 's/^DOMAIN=//p' .env | head -n 1)"
	[ "$current_domain" = "$DOMAIN" ] || say "note: .env keeps DOMAIN=$current_domain; edit it by hand to move this Studio to $DOMAIN."
	[ -n "$COMMAND_CENTER_TOKEN" ] || die ".env has no COMMAND_CENTER_TOKEN. Fill it with: openssl rand -hex 32"
else
	step "Writing .env with generated secrets"
	curl -fsSL "$REPO_RAW/.env.example" -o .env.example || die "could not download .env.example"
	COMMAND_CENTER_TOKEN="$(secret)"
	CLIENT_IP_HASH_SALT="$(secret)"
	TOKEN_ENCRYPTION_KEY="$(secret)"
	DOMAIN="$DOMAIN" CC="$COMMAND_CENTER_TOKEN" SALT="$CLIENT_IP_HASH_SALT" TEK="$TOKEN_ENCRYPTION_KEY" \
		awk '
			/^DOMAIN=/            { print "DOMAIN=" ENVIRON["DOMAIN"]; next }
			/^COMMAND_CENTER_TOKEN=/ { print "COMMAND_CENTER_TOKEN=" ENVIRON["CC"]; next }
			/^CLIENT_IP_HASH_SALT=/  { print "CLIENT_IP_HASH_SALT=" ENVIRON["SALT"]; next }
			/^TOKEN_ENCRYPTION_KEY=/ { print "TOKEN_ENCRYPTION_KEY=" ENVIRON["TEK"]; next }
			{ print }
		' .env.example > .env.tmp
	mv .env.tmp .env
	chmod 600 .env
	rm -f .env.example
	say "Three secrets generated. Everything else in .env is optional."
fi

# --- start --------------------------------------------------------------
step "Starting the stack"
docker compose pull --quiet || true
docker compose up -d

step "Waiting for https://$DOMAIN/readyz"
ready=0
i=0
while [ "$i" -lt 60 ]; do
	if curl -fsS --max-time 5 "https://$DOMAIN/readyz" >/dev/null 2>&1; then ready=1; break; fi
	i=$((i + 1))
	sleep 5
done

if [ "$ready" -eq 1 ]; then
	cat <<BANNER

Solo Publisher is up.

  Command Center: https://$DOMAIN/command-center?token=$COMMAND_CENTER_TOKEN

The token is in $PWD/.env; treat that file as a credential.
The public website is off. Turn it on with:

  docker compose exec app bun /app/ops/cli.js studio-profile-set --site-enabled

BANNER
else
	cat <<BANNER

The containers are running, but https://$DOMAIN/readyz did not answer within five minutes.
Usually that is TLS: Caddy needs ports 80 and 443 reachable from the internet to
get a certificate. Check with:

  cd $PWD && docker compose logs caddy --tail 50
  cd $PWD && docker compose logs app --tail 50

Command Center, once it answers: https://$DOMAIN/command-center?token=$COMMAND_CENTER_TOKEN

BANNER
	exit 1
fi
