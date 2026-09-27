/**
 * 扫码绑定 QQ 机器人，自动获取 AppID / AppSecret 并写入 .env。
 *
 * 使用 `@tencent-connect/qqbot-connector`：
 *   - 向 q.qq.com 申请绑定任务，在终端打印二维码；
 *   - 手机 QQ 扫码完成绑定后，轮询拿到加密凭据并本地解密；
 *   - 把 QQBOT_APP_ID / QQBOT_APP_SECRET 写回 .env。
 *
 * 注意：这一步只负责拿凭据。收到消息仍然依赖 `@tencent-connect/qqbot-nodejs`
 * 协议层（见 src/bot.ts）。
 *
 * 运行：pnpm qq:login
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { qrConnect } from '@tencent-connect/qqbot-connector';

const ENV_PATH = resolve(process.cwd(), '.env');

/** 覆盖或追加 KEY=value，保留其它行。 */
function upsertEnv(content: string, key: string, value: string): string {
  const lines = content.split('\n');
  let found = false;
  const updated = lines.map((line) => {
    if (line.trimStart().startsWith(`${key}=`)) {
      found = true;
      return `${key}=${value}`;
    }
    return line;
  });
  if (!found) {
    if (updated.length > 0 && updated[updated.length - 1] === '') {
      updated.splice(updated.length - 1, 0, `${key}=${value}`);
    } else {
      updated.push(`${key}=${value}`);
    }
  }
  return updated.join('\n');
}

const controller = new AbortController();
const onSigint = (): void => {
  console.log('\n已取消扫码绑定。');
  controller.abort();
};
process.once('SIGINT', onSigint);

console.log('正在向 QQ 申请绑定二维码…');

try {
  const credentials = await qrConnect({ signal: controller.signal });
  const first = credentials[0];
  if (first === undefined) {
    console.error('绑定成功但未返回任何凭据。');
    process.exit(1);
  }

  const { appId, appSecret, userOpenid } = first;
  const content = existsSync(ENV_PATH) ? readFileSync(ENV_PATH, 'utf8') : '';
  const next = upsertEnv(upsertEnv(content, 'QQBOT_APP_ID', appId), 'QQBOT_APP_SECRET', appSecret);
  writeFileSync(ENV_PATH, next, 'utf8');

  console.log('\n绑定成功，已写入 .env：');
  console.log(`  QQBOT_APP_ID=${appId}`);
  console.log('  QQBOT_APP_SECRET=***');
  if (userOpenid !== undefined) {
    console.log(`  扫码用户 openid=${userOpenid}`);
  }
  console.log('\n下一步：');
  console.log('  pnpm start            # WebSocket 模式直接收消息');
  console.log('  或设置 QQBOT_TRANSPORT=webhook 后启动并配置回调地址');
} catch (error) {
  if (controller.signal.aborted) {
    process.exit(0);
  }
  console.error('扫码绑定失败：', error instanceof Error ? error.message : String(error));
  process.exit(1);
} finally {
  process.off('SIGINT', onSigint);
}
