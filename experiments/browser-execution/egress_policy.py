"""Pure Squid7.7 configuration adapter; not authority or a qualified network boundary.

Original MIT adapter, integrated from DSH's implementation. No Squid source is copied.
The separate proxy requires host packet enforcement and original-grant tunnel teardown.
"""
from __future__ import annotations

from dataclasses import dataclass
import ipaddress
import re

PRIVATE_V4 = tuple(ipaddress.ip_network(n) for n in (
    "10.0.0.0/8", "172.16.0.0/12", "192.168.0.0/16"))
MAPPED_V4 = ipaddress.ip_network("::ffff:0:0/96")
# Explicit denials matter for mixed DNS answers: negating an "any public address"
# ACL cannot reject a set containing both a public address and a private address.
NONPUBLIC_V6 = tuple(
    str(part)
    for network in ipaddress.ip_network("::/0").address_exclude(ipaddress.ip_network("2000::/3"))
    for part in (network.address_exclude(MAPPED_V4) if MAPPED_V4.subnet_of(network) else (network,))
)
# Special ranges inside global unicast are conservatively denied, including IETF
# assignments with public exceptions. The host must also block its management addresses.
BLOCKED = (
    "0.0.0.0/8", "10.0.0.0/8", "100.64.0.0/10", "127.0.0.0/8",
    "169.254.0.0/16", "172.16.0.0/12", "192.0.0.0/24", "192.0.2.0/24",
    "192.88.99.0/24", "192.168.0.0/16", "198.18.0.0/15", "198.51.100.0/24",
    "203.0.113.0/24", "224.0.0.0/4", "240.0.0.0/4",
    "2001::/23", "2001:db8::/32", "2002::/16", "3ffe::/16", "3fff::/20",
) + NONPUBLIC_V6
KEYS = {"listen_address", "listen_port", "client_address", "origins", "forbidden_networks"}
LABEL = re.compile(r"[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\Z")
NUMERIC = re.compile(r"(?:0x[0-9a-f]+|[0-9]+)\Z")


class EgressPolicyError(ValueError):
    """Invalid trusted configuration; messages contain no supplied values."""


def require(condition):
    if not condition:
        raise EgressPolicyError("Invalid browser egress policy.")


def private_v4(value):
    require(type(value) is str and 1 <= len(value) <= 15)
    try:
        address = ipaddress.IPv4Address(value)
    except ValueError:
        raise EgressPolicyError("Invalid browser egress policy.") from None
    require(str(address) == value and any(address in net for net in PRIVATE_V4))
    return value


def port(value, minimum=1):
    require(type(value) is int and minimum <= value <= 65535)
    return value


def host(value):
    require(type(value) is str and 1 <= len(value) <= 253 and value.isascii())
    labels = value.split(".")
    require(len(labels) >= 2 and all(LABEL.fullmatch(label) for label in labels))
    require(not any(label.startswith("xn--") for label in labels))
    require(not all(NUMERIC.fullmatch(label) for label in labels))
    require(labels[-1] != "localhost")
    return value


@dataclass(frozen=True)
class Origin:
    scheme: str
    host: str
    port: int


@dataclass(frozen=True)
class Policy:
    listen_address: str
    listen_port: int
    client_address: str
    origins: tuple[Origin, ...]
    forbidden_networks: tuple[str, ...]


def validate_policy(value):
    require(type(value) is dict and KEYS - {"forbidden_networks"} <= value.keys() <= KEYS)
    listen, client = private_v4(value["listen_address"]), private_v4(value["client_address"])
    require(listen != client)
    listen_port = port(value["listen_port"], 1024)
    raw = value["origins"]
    require(type(raw) is list and 1 <= len(raw) <= 10)
    origins = []
    for item in raw:
        require(type(item) is dict and item.keys() == {"scheme", "host", "port"})
        require(type(item["scheme"]) is str and item["scheme"] in ("http", "https"))
        origin = Origin(item["scheme"], host(item["host"]), port(item["port"]))
        require(origin not in origins)
        origins.append(origin)
    raw = value.get("forbidden_networks", [])
    require(type(raw) is list and len(raw) <= 32)
    networks = []
    for item in raw:
        require(type(item) is str and 1 <= len(item) <= 49)
        try:
            network = ipaddress.ip_network(item, strict=True)
        except ValueError:
            raise EgressPolicyError("Invalid browser egress policy.") from None
        require(network.with_prefixlen == item)
        # Squid normalizes IPv4 into this range; do not silently widen a caller's
        # IPv6-only prohibition into a prohibition of ordinary IPv4 connections.
        require(network.version != 6 or not network.overlaps(MAPPED_V4))
        if item not in networks:
            networks.append(item)
    return Policy(listen, listen_port, client, tuple(origins), tuple(networks))


def compile_egress_policy(value):
    policy = validate_policy(value)
    lines = [
        "# OpenBot experimental Squid7.7 policy; host enforcement is still required.",
        f"http_port {policy.listen_address}:{policy.listen_port}",
        "visible_hostname openbot-browser-egress",
        "cache deny all", "cache_mem 0 MB", "access_log none", "cache_log /dev/null",
        "pid_filename /tmp/openbot-squid.pid", "coredump_dir /tmp",
        "netdb_filename none", "icp_port 0", "htcp_port 0", "pinger_enable off", "shutdown_lifetime 1 seconds",
        f"acl browser_client src {policy.client_address}/32",
        "acl connect_method method CONNECT", "acl http_protocol proto HTTP",
        "acl named_scope dstdomain -n " + " ".join(dict.fromkeys(o.host for o in policy.origins)),
    ]
    lines.extend("acl blocked_dst dst " + network for network in (*BLOCKED, *policy.forbidden_networks))
    for i, origin in enumerate(policy.origins):
        escaped = origin.host.replace(".", r"\.")
        lines.extend((f"acl origin{i}_domain dstdomain -n {origin.host}",
                      f"acl origin{i}_exact dstdom_regex -n ^{escaped}$",
                      f"acl origin{i}_port port {origin.port}"))
    lines.extend(("http_access deny manager", "http_access deny !browser_client",
                  "http_access deny !named_scope", "http_access deny blocked_dst"))
    for i, origin in enumerate(policy.origins):
        method = "http_protocol !connect_method" if origin.scheme == "http" else "connect_method"
        lines.append(f"http_access allow browser_client origin{i}_domain origin{i}_exact origin{i}_port {method}")
    lines.append("http_access deny all")
    return "\n".join(lines) + "\n"
