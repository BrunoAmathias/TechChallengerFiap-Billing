// Ambiente padrão dos testes: sem agente New Relic e sem ruído de log.
process.env.NODE_ENV = process.env.NODE_ENV || 'test';
process.env.NEW_RELIC_ENABLED = process.env.NEW_RELIC_ENABLED || 'false';
process.env.NEW_RELIC_NO_CONFIG_FILE = process.env.NEW_RELIC_NO_CONFIG_FILE || 'true';
process.env.LOG_LEVEL = process.env.LOG_LEVEL || 'silent';
