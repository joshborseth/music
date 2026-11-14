#!/usr/bin/env bash
# Makes the HTTPS certificate the phone uses on the home network
# (apps/server/src/lanHttps.ts), and renews it when it gets old.
#
#   scripts/lan-cert.sh           make or renew what is missing or expiring
#   scripts/lan-cert.sh --check   exit 1 when the certificate needs renewing
#
# The first run makes a certificate authority of this machine's own in
# ~/.local/share/music/tls (ca.crt, ca.key). The phone installs ca.crt once,
# from http://192.168.1.67:4310/certificate. The authority can only vouch for
# the one address (name constraints), so its key can't be used to pass off any
# other site to the phone. Every run then makes sure server.crt, for that
# address, has at least RENEW_DAYS left; a new one is valid for 397 days,
# within what Apple accepts. music.service runs this before it starts, and
# scripts/activate-release.sh restarts the server, when nothing plays, once
# the certificate needs renewing.
set -euo pipefail

check=false
case "${1:-}" in
  --check) check=true ;;
  "") ;;
  *)
    echo "Usage: $0 [--check]" >&2
    exit 2
    ;;
esac

tls_dir="${MUSIC_TLS_DIR:-$HOME/.local/share/music/tls}"
lan_ip="${LAN_IP:-192.168.1.67}"
renew_days="${RENEW_DAYS:-60}"
ca_key="$tls_dir/ca.key"
ca_crt="$tls_dir/ca.crt"
server_key="$tls_dir/server.key"
server_crt="$tls_dir/server.crt"

server_is_current() {
  [ -s "$server_key" ] && [ -s "$server_crt" ] && [ -s "$ca_crt" ] &&
    openssl x509 -in "$server_crt" -noout -checkend $((renew_days * 86400)) >/dev/null &&
    openssl x509 -in "$server_crt" -noout -ext subjectAltName | grep -qx "\s*IP Address:$lan_ip" &&
    openssl verify -CAfile "$ca_crt" "$server_crt" >/dev/null 2>&1
}

if [ "$check" = true ]; then
  server_is_current
  exit
fi

if server_is_current; then
  exit 0
fi

mkdir -p "$tls_dir"
chmod 700 "$tls_dir"
umask 077
work="$(mktemp -d "$tls_dir/.new.XXXXXX")"
trap 'rm -rf "$work"' EXIT

ca_is_current() {
  [ -s "$ca_key" ] && [ -s "$ca_crt" ] &&
    openssl x509 -in "$ca_crt" -noout -ext nameConstraints |
    grep -qx "\s*IP:$lan_ip/255.255.255.255"
}

if ! ca_is_current; then
  if [ -s "$ca_crt" ]; then
    echo "The certificate authority is not for $lan_ip: the phone must install the new one." >&2
  fi
  echo "Making a certificate authority for $lan_ip."
  openssl ecparam -name prime256v1 -genkey -noout -out "$work/ca.key"
  cat >"$work/ca.cnf" <<EOF
[req]
distinguished_name = dn
prompt = no
x509_extensions = ca
[dn]
CN = Joshify on the home network
O = Joshify
[ca]
basicConstraints = critical, CA:TRUE, pathlen:0
keyUsage = critical, keyCertSign, cRLSign
subjectKeyIdentifier = hash
nameConstraints = critical, permitted;IP:$lan_ip/255.255.255.255, permitted;DNS:joshify.invalid
EOF
  openssl req -new -x509 -sha256 -days 3650 -key "$work/ca.key" \
    -config "$work/ca.cnf" -out "$work/ca.crt"
  mv "$work/ca.key" "$ca_key"
  mv "$work/ca.crt" "$ca_crt"
  chmod 644 "$ca_crt"
fi

echo "Making the HTTPS certificate for $lan_ip."
openssl ecparam -name prime256v1 -genkey -noout -out "$work/server.key"
cat >"$work/server.cnf" <<EOF
[req]
distinguished_name = dn
prompt = no
[dn]
# Not the address: a name constraint checks a common name that looks like a
# host name, and the authority permits no host names.
CN = Joshify server
[server]
basicConstraints = critical, CA:FALSE
keyUsage = critical, digitalSignature
extendedKeyUsage = serverAuth
subjectAltName = IP:$lan_ip
subjectKeyIdentifier = hash
authorityKeyIdentifier = keyid
EOF
openssl req -new -sha256 -key "$work/server.key" -config "$work/server.cnf" \
  -out "$work/server.csr"
openssl x509 -req -sha256 -days 397 -in "$work/server.csr" \
  -CA "$ca_crt" -CAkey "$ca_key" -set_serial "0x$(openssl rand -hex 16)" \
  -extfile "$work/server.cnf" -extensions server -out "$work/server.crt"
openssl verify -CAfile "$ca_crt" "$work/server.crt" >/dev/null
mv "$work/server.key" "$server_key"
mv "$work/server.crt" "$server_crt"
