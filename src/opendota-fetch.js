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

function requestWithAgent(url, options, agent) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const requestFn = parsed.protocol === 'https:' ? httpsRequest : httpRequest;

    const req = requestFn(parsed, {
      method: options.method || 'GET',
      headers: options.headers,
      agent
    }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => {
        const body = Buffer.concat(chunks);
        resolve({
          ok: res.statusCode >= 200 && res.statusCode < 300,
          status: res.statusCode,
          json: async () => JSON.parse(body.toString('utf8')),
          text: async () => body.toString('utf8')
        });
      });
    });

    req.on('error', reject);
    req.end();
  });
}

export function createOpenDotaFetch(proxyConfig) {
  const proxyUrl = buildProxyUrl(proxyConfig);
  if (!proxyUrl) {
    return (url, options) => fetch(url, options);
  }

  const agent = new HttpsProxyAgent(proxyUrl);
  return (url, options) => requestWithAgent(url, options, agent);
}
