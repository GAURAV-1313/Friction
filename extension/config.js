// Set to 'local' for localhost dev, 'production' for deployed services.
const ENV = 'production';

const CONFIG_BY_ENV = {
  local: {
    API_BASE: 'http://localhost:4000',
    WEB_APP_URL: 'http://localhost:3000/reports'
  },
  production: {
    API_BASE: 'https://friction.onrender.com',
    WEB_APP_URL: 'https://nofriction.netlify.app/reports'
  }
};

globalThis.FRICTION_CONFIG = CONFIG_BY_ENV[ENV] || CONFIG_BY_ENV.production;
