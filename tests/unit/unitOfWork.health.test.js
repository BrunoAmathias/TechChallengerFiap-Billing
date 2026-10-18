jest.mock('../../src/infrastructure/database/connection', () => ({ query: jest.fn(), connect: jest.fn() }));

const pool = require('../../src/infrastructure/database/connection');
const { UnitOfWork } = require('../../src/infrastructure/database/unitOfWork');
const healthController = require('../../src/interfaces/controllers/health.controller');

function fakeClient() {
  return { query: jest.fn().mockResolvedValue({}), release: jest.fn() };
}

describe('UnitOfWork', () => {
  it('faz BEGIN/COMMIT e devolve o resultado', async () => {
    const client = fakeClient();
    const uow = new UnitOfWork({ connect: jest.fn().mockResolvedValue(client) });

    const result = await uow.run(async (tx) => {
      expect(tx).toBe(client);
      return 'ok';
    });

    expect(result).toBe('ok');
    expect(client.query.mock.calls.map((c) => c[0])).toEqual(['BEGIN', 'COMMIT']);
    expect(client.release).toHaveBeenCalled();
  });

  it('faz ROLLBACK e propaga o erro', async () => {
    const client = fakeClient();
    const uow = new UnitOfWork({ connect: jest.fn().mockResolvedValue(client) });

    await expect(uow.run(async () => { throw new Error('falhou'); })).rejects.toThrow('falhou');

    expect(client.query.mock.calls.map((c) => c[0])).toEqual(['BEGIN', 'ROLLBACK']);
    expect(client.release).toHaveBeenCalled();
  });
});

describe('HealthK8sController', () => {
  function fakeRes() {
    const res = { status: jest.fn(), json: jest.fn() };
    res.status.mockReturnValue(res);
    return res;
  }

  it('live responde 200 sem checar dependências', async () => {
    const res = fakeRes();
    await healthController.live({}, res);
    expect(res.status).toHaveBeenCalledWith(200);
    expect(pool.query).not.toHaveBeenCalled();
  });

  it.each([
    ['OK com banco e broker UP', true, true, 200, 'OK', 'UP'],
    ['DEGRADED com broker fora', true, false, 200, 'DEGRADED', 'DOWN'],
    ['DOWN (503) com banco fora', false, true, 503, 'DOWN', 'UP']
  ])('%s', async (_caso, bancoOk, brokerOk, httpStatus, status, broker) => {
    pool.query.mockReset();
    if (bancoOk) pool.query.mockResolvedValue({});
    else pool.query.mockRejectedValue(new Error('down'));
    const res = fakeRes();
    const req = { app: { locals: { mensageria: { isConnected: () => brokerOk } } } };

    await healthController.checkHealth(req, res);

    expect(res.status).toHaveBeenCalledWith(httpStatus);
    expect(res.json.mock.calls[0][0]).toMatchObject({ status, checks: { broker } });
  });

  it('informa broker DISABLED sem mensageria configurada', async () => {
    pool.query.mockResolvedValue({});
    const res = fakeRes();

    await healthController.checkHealth({ app: { locals: {} } }, res);

    expect(res.json.mock.calls[0][0].checks.broker).toBe('DISABLED');
  });
});
