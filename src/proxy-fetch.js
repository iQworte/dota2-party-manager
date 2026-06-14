import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { HttpsProxyAgent } from 'https-proxy-agent';

export function normalizeProxyConfig(proxy) {
  const source = proxy && typeof proxy === 'object' ? proxy : {};
  return {
    host: String(source.host || source.ip || '').trim(),
    port: String(source.port || '').trim(),
    login: String(source.login || '').trim(),
    pass: String(source.pass || source.password || '').trim()
  };
}

export function buildProxyUrl(proxy) {
  const normalized = normalizeProxyConfig(proxy);
  if (!normalized.host || !normalized.port) return null;

  const port = Number(normalized.port);
  if (!Number.isFinite(port) || port < 1 || port > 65535) return null;

  if (normalized.login && normalized.pass) {
    return `http://${encodeURIComponent(normalized.login)}:${encodeURIComponent(normalized.pass)}@${normalized.host}:${port}`;
  }

  return `http://${normalized.host}:${port}`;
}

export function postJson(url, { headers = {}, body, proxyConfig, timeoutMs = 30000 } = {}) {
  const proxyUrl = buildProxyUrl(proxyConfig);
  const agent = proxyUrl ? new HttpsProxyAgent(proxyUrl) : undefined;
  const payload = typeof body === 'string' ? body : JSON.stringify(body);

  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const requestFn = parsed.protocol === 'https:' ? httpsRequest : httpRequest;
    const req = requestFn(parsed, {
      method: 'POST',
      headers: {
        ...headers,
        'content-length': String(Buffer.byteLength(payload))
      },
      agent
    }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        resolve({
          ok: res.statusCode >= 200 && res.statusCode < 300,
          status: res.statusCode,
          text: async () => text,
          json: async () => JSON.parse(text)
        });
      });
    });

    req.on('error', reject);
    req.setTimeout(timeoutMs, () => {
      req.destroy(new Error('Request timeout'));
    });
    req.end(payload);
  });
}
