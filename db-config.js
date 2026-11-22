function parseConnectionUrl(value) {
  if (!value) return null;
  try {
    const url = new URL(value);
    return {
      host: decodeURIComponent(url.hostname || ''),
      port: Number(url.port || 5432),
      user: decodeURIComponent(url.username || ''),
      password: decodeURIComponent(url.password || ''),
      database: decodeURIComponent(url.pathname.replace(/^\//, '')),
      sslMode: url.searchParams.get('sslmode') || ''
    };
  } catch (error) {
    return null;
  }
}

function getConfig() {
  const fromUrl = parseConnectionUrl(process.env.DATABASE_URL || process.env.POSTGRES_URL);
  const config = {
    host: process.env.PG_HOST || fromUrl?.host || '127.0.0.1',
    port: Number(process.env.PG_PORT || fromUrl?.port || 5433),
    user: process.env.PG_USER || fromUrl?.user || 'n8n',
    password: process.env.PG_PASSWORD !== undefined ? process.env.PG_PASSWORD : fromUrl?.password,
    database: process.env.PG_DATABASE || fromUrl?.database || 'n8n'
  };

  const sslMode = process.env.PG_SSL || fromUrl?.sslMode || '';
  if (/^(true|1|require|required)$/i.test(sslMode)) {
    config.ssl = { rejectUnauthorized: false };
  } else if (/^(false|0|disable)$/i.test(sslMode)) {
    config.ssl = false;
  } else if (fromUrl && !/^disable$/i.test(fromUrl.sslMode)) {
    config.ssl = { rejectUnauthorized: false };
  }
  return config;
}

function isRemote() {
  const config = getConfig();
  if (!config.host || !config.password) return false;
  return !/^(localhost|127\.0\.0\.1|::1|0\.0\.0\.0)$/i.test(config.host);
}

module.exports = { getConfig, isRemote };
