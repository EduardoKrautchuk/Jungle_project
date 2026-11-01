import net from 'node:net';

export class TcpProxy {
  readonly #sockets = new Set<net.Socket>();
  #server: net.Server | undefined;

  private constructor(
    readonly port: number,
    private readonly targetHost: string,
    private readonly targetPort: number,
  ) {}

  static async start(
    targetHost: string,
    targetPort: number,
  ): Promise<TcpProxy> {
    const probe = net.createServer();
    const port = await new Promise<number>((resolve, reject) => {
      probe.once('error', reject);
      probe.listen(0, '127.0.0.1', () => {
        const address = probe.address();
        resolve(
          typeof address === 'object' && address !== null ? address.port : 0,
        );
      });
    });
    await new Promise<void>((resolve) => probe.close(() => resolve()));
    const proxy = new TcpProxy(port, targetHost, targetPort);
    await proxy.resume();
    return proxy;
  }

  async resume(): Promise<void> {
    if (this.#server !== undefined) {
      return;
    }
    const server = net.createServer((client) => {
      const upstream = net.connect(this.targetPort, this.targetHost);
      this.#track(client);
      this.#track(upstream);
      client.pipe(upstream);
      upstream.pipe(client);
      const destroyBoth = () => {
        client.destroy();
        upstream.destroy();
      };
      client.on('error', destroyBoth);
      upstream.on('error', destroyBoth);
      client.on('close', destroyBoth);
      upstream.on('close', destroyBoth);
    });
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(this.port, '127.0.0.1', () => resolve());
    });
    this.#server = server;
  }

  async pause(): Promise<void> {
    const server = this.#server;
    this.#server = undefined;
    for (const socket of this.#sockets) {
      socket.destroy();
    }
    this.#sockets.clear();
    if (server !== undefined) {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  }

  #track(socket: net.Socket): void {
    this.#sockets.add(socket);
    socket.on('close', () => this.#sockets.delete(socket));
  }
}
