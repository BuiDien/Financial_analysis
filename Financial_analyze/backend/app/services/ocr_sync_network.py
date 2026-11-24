"""LAN address detection and loopback checks for the OCR sync coordinator."""

import ipaddress
import os
import re
import shutil
import socket
import subprocess

from ..config import get_settings

settings = get_settings()


def is_loopback_peer(host: str | None) -> bool:
    """A worker on this machine (127.0.0.1 / ::1 / ::ffff:127.0.0.1) needs no pairing code."""
    try:
        address = ipaddress.ip_address(host or "")
    except ValueError:
        return False
    mapped = getattr(address, "ipv4_mapped", None)
    return address.is_loopback or bool(mapped and mapped.is_loopback)


_NON_LAN_INTERFACE_PREFIXES = (
    "lo", "utun", "tun", "tap", "wg", "tailscale", "ppp", "ipsec", "vpn",
    "docker", "bridge", "veth", "awdl", "llw", "anpi", "gif", "stf",
)


def valid_lan_ip(value: str) -> bool:
    try:
        address = ipaddress.ip_address(value)
    except ValueError:
        return False
    return (
        address.version == 4
        and not address.is_loopback
        and not address.is_link_local
        and not address.is_multicast
        and not address.is_unspecified
    )


def parse_physical_interface_ips(output: str) -> list[str]:
    """Return active physical-interface IPv4 addresses, best choice first."""
    candidates = []
    blocks = re.split(r"(?m)(?=^[A-Za-z0-9_.:-]+: flags=)", output or "")
    for block in blocks:
        header = block.splitlines()[0] if block.splitlines() else ""
        match = re.match(r"([A-Za-z0-9_.:-]+): flags=.*<([^>]*)>", header)
        if not match:
            continue
        name, flags = match.group(1), set(match.group(2).split(","))
        lowered = name.lower()
        if lowered.startswith(_NON_LAN_INTERFACE_PREFIXES):
            continue
        if "UP" not in flags or "status: inactive" in block.lower():
            continue
        priority = (
            0 if lowered == "en0"
            else 1 if lowered.startswith(("wlan", "wlp"))
            else 2 if lowered.startswith(("en", "eth"))
            else 3
        )
        for address in re.findall(r"(?m)^\s*inet\s+(\d+\.\d+\.\d+\.\d+)\b", block):
            if valid_lan_ip(address):
                candidates.append((priority, not ipaddress.ip_address(address).is_private, address))
    return [address for _priority, _public, address in sorted(candidates)]


def physical_interface_ips() -> list[str]:
    command = shutil.which("ifconfig")
    if not command and os.path.isfile("/sbin/ifconfig"):
        command = "/sbin/ifconfig"
    if not command:
        return []
    try:
        result = subprocess.run(
            [command], capture_output=True, check=False, text=True, timeout=2.0,
        )
    except (OSError, subprocess.SubprocessError):
        return []
    return parse_physical_interface_ips(result.stdout) if result.returncode == 0 else []


def lan_ip() -> str:
    """Return a worker-reachable LAN IP while ignoring VPN tunnel interfaces."""
    configured = settings.sync_advertised_host.strip()
    if configured:
        return configured
    physical = physical_interface_ips()
    if physical:
        return physical[0]

    try:
        hostname_ips = {
            item[4][0]
            for item in socket.getaddrinfo(socket.gethostname(), None, socket.AF_INET)
            if valid_lan_ip(item[4][0])
        }
        if hostname_ips:
            return sorted(
                hostname_ips,
                key=lambda address: not ipaddress.ip_address(address).is_private,
            )[0]
    except OSError:
        pass

    # Last-resort fallback for systems without ifconfig. This may follow a VPN,
    # so it is intentionally lower priority than physical-interface detection.
    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    try:
        s.connect(("8.8.8.8", 80))
        detected = s.getsockname()[0]
        return detected if valid_lan_ip(detected) else "127.0.0.1"
    except OSError:
        return "127.0.0.1"
    finally:
        s.close()
