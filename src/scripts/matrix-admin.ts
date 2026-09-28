/**
 * Matrix 房间成员管理 CLI。
 *
 * 运行：pnpm matrix:admin <status|invite|kick> --room ... --user ...
 */

import { ConfigError, loadMatrixBridgeConfig } from '../config.js';
import {
  MATRIX_ADMIN_USAGE,
  MatrixAdminArgumentError,
  runMatrixAdminCommand,
  type MatrixAdminResult,
} from '../matrix/admin.js';
import { MatrixClient } from '../matrix/client.js';

function printResult(result: MatrixAdminResult): void {
  if (result.action === 'status') {
    console.log(`房间：${result.roomId}`);
    console.log(`用户：${result.userId}`);
    if (result.displayName !== undefined) {
      console.log(`显示名：${result.displayName}`);
    }
    console.log(`成员状态：${result.membership}`);
    console.log(`Power level：${String(result.powerLevel)}`);
    console.log(`最低要求：${String(result.minimumPowerLevel)}`);
    console.log(`全局允许：${result.globallyAllowed ? '是' : '否'}`);
    console.log(`可转发：${result.canForward ? '是' : '否'}`);
    return;
  }

  console.log(
    result.action === 'invite'
      ? `已邀请 ${result.userId} 加入 ${result.roomId}`
      : `已踢出 ${result.userId}，房间：${result.roomId}`,
  );
  console.log(`操作者：${result.actor}`);
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args.includes('--help') || args.includes('-h')) {
    console.log(MATRIX_ADMIN_USAGE);
    return;
  }

  const config = loadMatrixBridgeConfig();
  if (config === undefined) {
    throw new ConfigError('Matrix bridge 未启用：请设置 MATRIX_BRIDGE_ENABLED=true');
  }
  const client = new MatrixClient(
    {
      homeserverUrl: config.homeserverUrl,
      accessToken: config.asToken,
      timeoutMs: config.requestTimeoutMs,
    },
    config.userId,
  );
  printResult(await runMatrixAdminCommand(args, client, config));
}

try {
  await main();
} catch (error) {
  if (error instanceof MatrixAdminArgumentError || error instanceof ConfigError) {
    console.error(error.message);
    console.error(`\n${MATRIX_ADMIN_USAGE}`);
  } else {
    console.error('Matrix 房间管理失败：', error);
  }
  process.exitCode = 1;
}
