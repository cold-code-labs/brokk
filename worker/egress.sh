#!/bin/sh
# Root-owned host prerequisite. Rules affect only the dedicated coder bridge.
set -eu
network=brokk-coder-egress
bridge=br-brokk-coder
if ! docker network inspect "$network" >/dev/null 2>&1; then
  docker network create --driver bridge --opt com.docker.network.bridge.name="$bridge" "$network" >/dev/null
fi
iptables -N BROKK-CODER-EGRESS 2>/dev/null || true
iptables -F BROKK-CODER-EGRESS
iptables -A BROKK-CODER-EGRESS -m conntrack --ctstate ESTABLISHED,RELATED -j ACCEPT
for range in 0.0.0.0/8 10.0.0.0/8 100.64.0.0/10 127.0.0.0/8 169.254.0.0/16 172.16.0.0/12 192.168.0.0/16 224.0.0.0/4 240.0.0.0/4; do
  iptables -A BROKK-CODER-EGRESS -d "$range" -j REJECT
done
iptables -A BROKK-CODER-EGRESS -p tcp -m multiport --dports 80,443,53 -j ACCEPT
iptables -A BROKK-CODER-EGRESS -p udp --dport 53 -j ACCEPT
iptables -A BROKK-CODER-EGRESS -j REJECT
iptables -C DOCKER-USER -i "$bridge" -j BROKK-CODER-EGRESS 2>/dev/null || iptables -I DOCKER-USER 1 -i "$bridge" -j BROKK-CODER-EGRESS
iptables -C INPUT -i "$bridge" -j REJECT 2>/dev/null || iptables -I INPUT 1 -i "$bridge" -j REJECT
