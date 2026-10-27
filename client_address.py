"""Canonical client address across an explicitly trusted proxy chain.

This file is copied into the four independent image build contexts. Configured
Docker service names are resolved with a short cache so recreation never needs
trust in an entire bridge subnet. A lookup failure keeps the real peer address.
"""
import ipaddress
import os
import socket
import threading
import time

_cache = {}
_lock = threading.Lock()


def _address(value):
    try:
        parsed = ipaddress.ip_address(value)
        return parsed.ipv4_mapped if getattr(parsed, 'ipv4_mapped', None) else parsed
    except (ValueError, TypeError):
        return None


def _networks(values):
    if isinstance(values, str):
        values = values.split(',')
    result = []
    for value in values or ():
        try:
            result.append(ipaddress.ip_network(value.strip() if isinstance(value, str) else value))
        except (ValueError, TypeError):
            continue
    return result


def _dns_addresses(host):
    now = time.monotonic()
    with _lock:
        cached = _cache.get(host)
        if cached and cached[0] > now:
            return cached[1]
    try:
        addresses = {_address(row[4][0]) for row in socket.getaddrinfo(host, None, type=socket.SOCK_STREAM)}
        addresses.discard(None)
    except OSError:
        addresses = set()
    with _lock:
        _cache[host] = (now + 5, addresses)
    return addresses


def resolve_client_ip(peer, headers, *, proxy_cidrs=None, proxy_hosts=None, tunnel_cidrs=None):
    address = _address(peer)
    if address is None:
        return peer
    if proxy_cidrs is None:
        proxy_cidrs = os.environ.get('TRUSTED_PROXY_CIDRS', '127.0.0.1/32,::1/128')
    if proxy_hosts is None:
        proxy_hosts = os.environ.get('TRUSTED_PROXY_HOSTS', '')
    if tunnel_cidrs is None:
        tunnel_cidrs = os.environ.get('TRUSTED_TUNNEL_CIDRS', '')
    if isinstance(proxy_hosts, str):
        proxy_hosts = [host.strip() for host in proxy_hosts.split(',') if host.strip()]
    trusted = any(address in network for network in _networks(proxy_cidrs))
    if not trusted:
        trusted = any(address in _dns_addresses(host) for host in proxy_hosts)
    if trusted:
        candidate = _address(headers.get('X-Auth-Client'))
        if candidate is not None:
            return str(candidate)
    # A direct Tunnel ingress is a separate role. It may supply CF's overwritten
    # header, but cannot turn an externally supplied X-Auth-Client into authority.
    if any(address in network for network in _networks(tunnel_cidrs)):
        candidate = _address(headers.get('CF-Connecting-IP'))
        if candidate is not None:
            return str(candidate)
    return str(address)
