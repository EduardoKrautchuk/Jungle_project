import { NestFactory } from '@nestjs/core';
import { AppModule } from '../../../src/app.module.js';

const app = await NestFactory.create(AppModule.forRoot('test'), {
  logger: ['error'],
});
app.enableShutdownHooks();
await app.listen(0, '127.0.0.1');
process.stdout.write(`READY ${await app.getUrl()}\n`);
