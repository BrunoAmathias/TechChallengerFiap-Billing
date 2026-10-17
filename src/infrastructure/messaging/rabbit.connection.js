const { EventEmitter } = require("node:events");
const defaultLogger = require("../logger");

/**
 * Conexão com o RabbitMQ com reconexão automática.
 * Emite "connected" a cada (re)conexão para que o consumer refaça a topologia.
 */
class RabbitConnection extends EventEmitter {
  constructor({ url, amqp = require("amqplib"), reconnectDelayMs = 5000, logger = defaultLogger }) {
    super();
    this.url = url;
    this.amqp = amqp;
    this.reconnectDelayMs = reconnectDelayMs;
    this.logger = logger;
    this.connection = null;
    this.publishChannel = null;
    this.closing = false;
    this.reconnectTimer = null;
  }

  async connect() {
    if (this.closing) return;

    try {
      const connection = await this.amqp.connect(this.url, { heartbeat: 30 });

      connection.on("error", (err) => this.logger.error({ err }, "Erro na conexão com o RabbitMQ"));
      connection.on("close", () => {
        this.connection = null;
        this.publishChannel = null;
        if (!this.closing) {
          this.logger.warn("Conexão com o RabbitMQ encerrada, reconectando");
          this.scheduleReconnect();
        }
      });

      const publishChannel = await connection.createConfirmChannel();
      publishChannel.on("error", (err) => this.logger.error({ err }, "Erro no canal de publicação"));

      this.connection = connection;
      this.publishChannel = publishChannel;
      this.logger.info("RabbitMQ conectado");
      this.emit("connected", connection);
    } catch (err) {
      this.logger.error({ err }, "Falha ao conectar no RabbitMQ");
      this.scheduleReconnect();
    }
  }

  scheduleReconnect() {
    if (this.closing || this.reconnectTimer) return;

    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, this.reconnectDelayMs);
    this.reconnectTimer.unref?.();
  }

  isConnected() {
    return Boolean(this.connection && this.publishChannel);
  }

  getPublishChannel() {
    return this.publishChannel;
  }

  async createChannel() {
    if (!this.connection) throw new Error("RabbitMQ não conectado");
    return this.connection.createChannel();
  }

  async close() {
    this.closing = true;
    clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;

    if (this.connection) {
      await this.connection.close().catch(() => {});
    }
    this.connection = null;
    this.publishChannel = null;
  }
}

module.exports = RabbitConnection;
