/**
 * HTTP 传输示例：纯请求-响应脚本，不订阅事件。
 * 适合定时任务、CLI 工具等一次性调用。
 *
 * 用法：npm run http:check
 */
import { SnowLumaHttpClient } from '@snowluma/sdk';
import { logger } from '../logging/logger';

const log = logger.child('http-check');
const baseUrl = process.env.SNOWLUMA_HTTP_URL ?? 'http://127.0.0.1:3000/';
const accessToken = process.env.SNOWLUMA_TOKEN;

const bot = new SnowLumaHttpClient({
  baseUrl,
  accessToken,
  requestTimeoutMs: 10_000,
});

// 登录信息（快捷方法，类型完备）
const login = await bot.getLoginInfo();
log.info('登录账号', { userId: login.user_id, nickname: login.nickname });

// 运行状态（rawResponse 保留完整 OneBot 响应信封）
const status = await bot.rawResponse('get_status');
log.info('状态', { status: JSON.stringify(status) });
