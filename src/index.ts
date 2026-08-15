/**
 * 入口：加载配置 → 启动 Bot。
 */
import { loadConfig } from './config';
import { Bot } from './bot';

const config = loadConfig();
const bot = new Bot(config);
await bot.start();
