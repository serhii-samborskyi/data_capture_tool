function parseSingleProxy(rawInput) {
  const raw = String(rawInput || "").trim();
  if (!raw) return null;

  if (raw.includes("://")) {
    try {
      const url = new URL(raw);
      return {
        protocol: url.protocol.replace(":", "") || "http",
        host: url.hostname,
        port: Number(url.port || 80),
        username: decodeURIComponent(url.username || ""),
        password: decodeURIComponent(url.password || "")
      };
    } catch {
      return null;
    }
  }

  // Supports: ip:port@user:pass
  const splitAt = raw.split("@");
  if (splitAt.length === 2) {
    const hostPort = splitAt[0].trim();
    const userPass = splitAt[1].trim();
    const [host, portText] = hostPort.split(":");
    const [username = "", password = ""] = userPass.split(":");
    const port = Number(portText);
    if (!host || Number.isNaN(port)) return null;
    return {
      protocol: detectProtocol(port),
      host,
      port,
      username,
      password
    };
  }

  // Supports: user:pass@ip:port
  try {
    const asUrl = new URL(`http://${raw}`);
    if (!asUrl.hostname || !asUrl.port) return null;
    const port = Number(asUrl.port);
    return {
      protocol: detectProtocol(port),
      host: asUrl.hostname,
      port,
      username: decodeURIComponent(asUrl.username || ""),
      password: decodeURIComponent(asUrl.password || "")
    };
  } catch {
    return null;
  }
}

function detectProtocol(port) {
  if (port === 1080) return "socks5";
  if (port === 1081) return "socks4";
  if (port === 443) return "https";
  return "http";
}

export function parseProxyList(proxyListText) {
  return String(proxyListText || "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => ({ raw: line, parsed: parseSingleProxy(line) }))
    .filter((item) => item.parsed)
    .map((item) => item.parsed);
}

export function toPlaywrightProxy(proxy) {
  if (!proxy) return undefined;
  return {
    server: `${proxy.protocol}://${proxy.host}:${proxy.port}`,
    username: proxy.username || undefined,
    password: proxy.password || undefined
  };
}

export function pickProxy(proxies, cursor = 0) {
  if (!Array.isArray(proxies) || proxies.length === 0) {
    return { proxy: null, nextCursor: 0 };
  }
  const index = cursor % proxies.length;
  return {
    proxy: proxies[index],
    nextCursor: (index + 1) % proxies.length
  };
}
