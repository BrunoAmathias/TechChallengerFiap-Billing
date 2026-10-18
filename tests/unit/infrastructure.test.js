jest.mock('pg', () => ({
  Pool: jest.fn().mockImplementation(() => ({ on: jest.fn(), query: jest.fn() }))
}));

const { buildConnectionString, buildSslConfig } = require('../../src/infrastructure/database/connection');
const logger = require('../../src/infrastructure/logger');
const { runWithCorrelationId, getCorrelationId } = require('../../src/infrastructure/logger');
const correlationIdMiddleware = require('../../src/interfaces/middlewares/correlationId.middleware');

describe('connection', () => {
  it('usa DB_URL quando informado', () => {
    expect(buildConnectionString({ DB_URL: 'postgresql://u:p@h/db', DB_HOST: 'outro' }))
      .toBe('postgresql://u:p@h/db');
  });

  it('monta a URL a partir das variáveis DB_* e escapa a senha', () => {
    const url = buildConnectionString({
      DB_HOST: 'localhost', DB_PORT: '5433', DB_NAME: 'oficina', DB_USER: 'postgres', DB_PASSWORD: 'p@ss:1'
    });
    expect(url).toBe('postgresql://postgres:p%40ss%3A1@localhost:5433/oficina');
  });

  it('usa valores padrão para porta, usuário e banco', () => {
    expect(buildConnectionString({ DB_HOST: 'db' })).toBe('postgresql://postgres:@db:5432/oficina');
  });

  it('retorna undefined sem DB_URL nem DB_HOST', () => {
    expect(buildConnectionString({})).toBeUndefined();
  });

  it('desliga SSL apenas com DB_SSL=false', () => {
    expect(buildSslConfig({ DB_SSL: 'false' })).toBe(false);
    expect(buildSslConfig({})).toEqual({ rejectUnauthorized: false });
  });
});

describe('logger', () => {
  it('propaga o correlationId no contexto assíncrono', async () => {
    expect(getCorrelationId()).toBeUndefined();

    await runWithCorrelationId(42, async () => {
      await Promise.resolve();
      expect(getCorrelationId()).toBe('42');
    });

    expect(getCorrelationId()).toBeUndefined();
  });

  it('inclui o correlationId nas linhas de log', () => {
    const lines = [];
    const child = require('pino')(
      { mixin: () => ({ correlationId: getCorrelationId() }) },
      { write: (l) => lines.push(JSON.parse(l)) }
    );

    runWithCorrelationId('abc', () => child.info('teste'));

    expect(lines[0].correlationId).toBe('abc');
    expect(typeof logger.info).toBe('function');
  });
});

describe('correlationIdMiddleware', () => {
  function makeReqRes(headerValue) {
    const req = { get: jest.fn().mockReturnValue(headerValue) };
    const res = { set: jest.fn() };
    return { req, res };
  }

  it('reaproveita o header x-correlation-id recebido', () => {
    const { req, res } = makeReqRes('corr-1');
    let idNoContexto;

    correlationIdMiddleware(req, res, () => { idNoContexto = getCorrelationId(); });

    expect(req.correlationId).toBe('corr-1');
    expect(res.set).toHaveBeenCalledWith('x-correlation-id', 'corr-1');
    expect(idNoContexto).toBe('corr-1');
  });

  it('gera um UUID quando o header não vem', () => {
    const { req, res } = makeReqRes(undefined);

    correlationIdMiddleware(req, res, () => {});

    expect(req.correlationId).toMatch(/^[0-9a-f-]{36}$/);
  });
});
